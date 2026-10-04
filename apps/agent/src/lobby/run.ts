import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import type { SnapshotRef, UploadTarget } from "@mc/protocol";
import { LeaseLostError, OfflineError, StaleRevError, type LobbyApi } from "../host/api";
import { ServerConsole, type ServerProcess } from "../host/console";
import { DOWNLOAD_ATTEMPTS, mb, SAVE_TIMEOUT_MS, UPLOAD_ATTEMPTS, type Timers } from "../host/deps";
import { ChecksumError } from "../host/snapshot";
import { tmpDirFor } from "../host/state";
import { bridgeCommand, GAME_PORT } from "./bridge";
import { lobbyServerDir, moveLobbyAside, readLobbyState, restoreLobby, writeLobbyState, zipLobby } from "./folder";

export const POLL_MS = 5_000;
export const LOBBY_BACKUP_MS = 30 * 60_000;

const DONE = /\]: Done \(\d/;
const SAVED = /Saved the game/;
/** 129/130/143: Java stopped by a closed window, Ctrl+C or SIGTERM, which is a normal stop. */
const NORMAL_EXIT = new Set([0, 129, 130, 143]);

/** Everything the lobby touches outside its own logic. Tests swap in fakes. */
export interface LobbyDeps {
  api: LobbyApi;
  dataDir: string;
  log: (line: string) => void;
  address: () => string;
  /** This machine's name, shown to a second lobby that's refused. */
  machine: string;
  /** --fresh: ignore the backups and start an empty lobby. */
  fresh: boolean;
  /** Paper, the bridge plugin, eula.txt, and server.properties for a new lobby. */
  prepareServer: (dir: string) => Promise<void>;
  ensureJava: () => Promise<string>;
  launch: (dir: string, javaBin: string) => ServerProcess;
  forwardInput: (cb: ((line: string) => void) | null) => void;
  download: (url: string, dest: string) => Promise<void>;
  upload: (target: { url: string; headers: Record<string, string> }, file: string) => Promise<void>;
  onStopSignal: (handler: () => void) => () => void;
  crashSummary: (serverDir: string, sinceMs: number) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timers: Timers;
  exit: (code: number) => void;
}

/** mc-host lobby: claim the slot, restore or create the folder, run Paper until it stops. */
export async function runLobby(deps: LobbyDeps): Promise<void> {
  const dir = lobbyServerDir(deps.dataDir);
  const local = await readLobbyState(deps.dataDir);
  const address = deps.address();
  const claim = await deps.api.claim({
    address,
    machine: deps.machine,
    ...(local.sessionId ? { previousSessionId: local.sessionId } : {}),
  });
  await writeLobbyState(deps.dataDir, { ...local, sessionId: claim.sessionId });

  // A restore and Paper's first start can take minutes, so keep the slot alive from here on.
  const stopEarlyPoll = deps.timers.every(POLL_MS, () => void deps.api.poll(claim.sessionId).catch(() => {}));
  const unhookEarly = deps.onStopSignal(() => {
    stopEarlyPoll();
    deps.log("Cancelled. Releasing the lobby slot…");
    void deps.api
      .release(claim.sessionId)
      .catch(() => {})
      .then(() => deps.exit(130));
  });
  let backupRev: number;
  let javaBin: string;
  try {
    backupRev = await restore(deps, dir, local.backupRev);
    await writeLobbyState(deps.dataDir, { sessionId: claim.sessionId, backupRev });
    await deps.prepareServer(dir);
    javaBin = await deps.ensureJava();
  } catch (err) {
    stopEarlyPoll();
    unhookEarly();
    await deps.api.release(claim.sessionId).catch(() => {});
    throw err;
  }

  const st = {
    sessionId: claim.sessionId,
    backupRev,
    ready: false,
    wanted: bridgeCommand(null),
    sent: null as string | null,
    offline: false,
    polling: false,
    lost: null as string | null,
    stopping: false,
    saving: null as Promise<void> | null,
  };
  const startedAt = deps.now();
  const server = deps.launch(dir, javaBin);
  const con = new ServerConsole(server);
  const stop = (why?: string) => {
    if (st.stopping) {
      deps.log("Still stopping, please wait…");
      return;
    }
    st.stopping = true;
    if (why) deps.log(why);
    con.send("stop");
  };
  const unhookStop = deps.onStopSignal(() => stop("Stopping the lobby and backing it up…"));
  unhookEarly();
  stopEarlyPoll();
  let stopPoll = () => {};
  try {
    deps.forwardInput((line) => con.send(line));
    const save = () => writeLobbyState(deps.dataDir, { sessionId: st.sessionId, backupRev: st.backupRev });
    const lose = (why: string) => {
      if (st.lost) return;
      st.lost = why;
      stop();
    };
    /** Paper reads commands only once it's up; until then the latest wish just waits. */
    const tell = () => {
      if (!st.ready || st.wanted === st.sent) return;
      con.send(st.wanted);
      st.sent = st.wanted;
    };
    con.onLine((line) => {
      if (!DONE.test(line)) return;
      st.ready = true;
      deps.log(`The lobby is up. Players connect to mc-lobby (${address}:${GAME_PORT}).`);
      tell();
    });

    /** The slot lapsed (a long outage) or was taken: take it back, unless another lobby holds it. */
    const reclaim = async () => {
      try {
        const again = await deps.api.claim({ address, machine: deps.machine, previousSessionId: st.sessionId });
        st.sessionId = again.sessionId;
        await save();
        deps.log("The lobby's slot had lapsed; it's back.");
      } catch (err) {
        if (err instanceof OfflineError) return;
        lose(`${(err as Error).message} This lobby is stopping without a backup.`);
      }
    };
    const poll = async () => {
      if (st.polling || st.stopping) return;
      st.polling = true;
      try {
        const r = await deps.api.poll(st.sessionId);
        if (st.offline) deps.log("Reached the Worker again.");
        st.offline = false;
        st.wanted = bridgeCommand(r.host);
        tell();
      } catch (err) {
        if (err instanceof LeaseLostError) {
          await reclaim();
        } else if (!st.offline) {
          st.offline = true;
          deps.log(`Can't reach the Worker (${(err as Error).message}). The lobby keeps running and tries again.`);
        }
      } finally {
        st.polling = false;
      }
    };
    stopPoll = deps.timers.every(POLL_MS, () => void poll());
    void poll();

    const backup = async () => {
      const file = join(tmpDirFor(deps.dataDir), "lobby-backup.zip");
      try {
        const zipped = await (async () => {
          try {
            con.send("save-off");
            con.send("save-all flush");
            await con.waitFor(SAVED, SAVE_TIMEOUT_MS);
            return await zipLobby(dir, file);
          } finally {
            if (!st.stopping) con.send("save-on");
          }
        })();
        // Upload after save-on, so the world isn't frozen while it runs.
        st.backupRev = await pushBackup(deps, st.sessionId, file, zipped);
        await save();
        deps.log(`Backed up the lobby as rev ${st.backupRev}.`);
      } catch (err) {
        // A newer backup exists, so another lobby has been running: this folder is out of date.
        if (err instanceof StaleRevError) return lose(`${err.message} This lobby is stopping without a backup.`);
        deps.log(`Warning: ${(err as Error).message} The lobby keeps running, and the next backup tries again.`);
      } finally {
        await rm(file, { force: true });
      }
    };
    const stopBackups = deps.timers.every(LOBBY_BACKUP_MS, () => {
      if (st.stopping || st.saving) return;
      st.saving = backup().finally(() => {
        st.saving = null;
      });
    });

    const code = await server.exited;
    stopBackups();
    stopPoll();
    deps.forwardInput(null);
    if (st.saving) await st.saving;

    if (st.lost) throw new UserError(`${st.lost} Its folder is still at ${dir}.`);
    if (!NORMAL_EXIT.has(code)) {
      deps.log(await deps.crashSummary(dir, startedAt));
      await deps.api.release(st.sessionId).catch(() => {});
      throw new UserError(`Paper stopped with exit code ${code}. Docker starts the lobby again; if it keeps crashing, check the log above.`);
    }

    deps.log("Backing up the lobby…");
    const file = join(tmpDirFor(deps.dataDir), "lobby-final.zip");
    try {
      st.backupRev = await pushBackup(deps, st.sessionId, file, await zipLobby(dir, file));
      await save();
      deps.log(`Backed up the lobby as rev ${st.backupRev}.`);
    } catch (err) {
      deps.log(`Couldn't back up the lobby (${(err as Error).message}). This machine's copy is kept and is backed up next time.`);
    } finally {
      await rm(file, { force: true });
    }
    await deps.api
      .release(st.sessionId)
      .catch((err) => deps.log(`Couldn't release the lobby slot (${(err as Error).message}). It frees itself within 2 minutes.`));
    deps.log("The lobby has stopped.");
  } finally {
    stopPoll();
    unhookStop();
  }
}

/** Decide what the lobby folder starts from. Returns the backup rev the folder now matches. */
async function restore(deps: LobbyDeps, dir: string, localRev: number): Promise<number> {
  const latest = await deps.api.latestBackup();
  const latestRev = latest?.rev ?? 0;
  if (deps.fresh) {
    const dest = await moveLobbyAside(deps.dataDir, deps.now());
    deps.log(dest ? `Starting a fresh lobby. The old one was moved to ${dest}.` : "Starting a fresh lobby.");
    return latestRev;
  }
  const hasLocal = existsSync(join(dir, "server.properties"));
  if (hasLocal && latestRev <= localRev) return localRev;
  if (hasLocal) {
    const dest = await moveLobbyAside(deps.dataDir, deps.now());
    deps.log(`The lobby on this machine is older than the backup (rev ${localRev}, the backup is rev ${latestRev}), so it was moved to ${dest}.`);
  }
  if (!latest) {
    deps.log("There's no lobby backup yet, so this is a fresh lobby.");
    return 0;
  }
  deps.log(`Restoring lobby backup rev ${latest.rev} (${mb(latest.size)} MB)…`);
  try {
    await fetchBackup(deps, latest, dir);
  } catch (err) {
    throw new UserError(
      `Couldn't restore lobby backup rev ${latest.rev}: ${(err as Error).message} Run \`mc-host lobby --fresh\` to start an empty lobby instead.`,
    );
  }
  return latest.rev;
}

/** Download a backup and unpack it into dir, retrying a damaged download. */
async function fetchBackup(deps: Pick<LobbyDeps, "download" | "log" | "dataDir">, latest: SnapshotRef, dir: string): Promise<void> {
  const file = join(tmpDirFor(deps.dataDir), `lobby-${latest.rev}.zip`);
  try {
    for (let attempt = 1; ; attempt++) {
      await deps.download(latest.url, file);
      try {
        await restoreLobby(file, dir, latest.sha256);
        return;
      } catch (err) {
        if (!(err instanceof ChecksumError) || attempt >= DOWNLOAD_ATTEMPTS) throw err;
        deps.log("The lobby backup download is damaged. Trying again…");
      }
    }
  } finally {
    await rm(file, { force: true });
  }
}

/** upload-url → PUT → commit, retried with backoff. A lost slot or a newer backup is never retried. */
async function pushBackup(
  deps: Pick<LobbyDeps, "api" | "upload" | "sleep">,
  sessionId: string,
  file: string,
  zipped: { sha256: string; size: number },
): Promise<number> {
  let last: Error | null = null;
  // Once the PUT has succeeded, retries repeat only the commit, whose reply may have been lost.
  let target: UploadTarget | null = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      if (!target) {
        const next = await deps.api.backupUrl({ sessionId, ...zipped });
        await deps.upload(next, file);
        target = next;
      }
      return await deps.api.commitBackup({ sessionId, rev: target.rev, key: target.key, ...zipped });
    } catch (err) {
      if (err instanceof LeaseLostError || err instanceof StaleRevError) throw err;
      last = err as Error;
      if (attempt < UPLOAD_ATTEMPTS) await deps.sleep(5_000 * 4 ** (attempt - 1));
    }
  }
  throw new UserError(`Couldn't upload the lobby backup after ${UPLOAD_ATTEMPTS} tries (${last?.message}).`);
}
