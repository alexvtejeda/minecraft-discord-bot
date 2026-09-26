import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { LeaseLostError, StaleRevError } from "./api";
import { ServerConsole } from "./console";
import { AUTOSAVE_MS, HEARTBEAT_MS, PREGEN_RADIUS, SAVE_TIMEOUT_MS, yes, type SessionDeps } from "./deps";
import type { Prepared } from "./prepare";
import { zipSnapshot } from "./snapshot";
import { moveToRecovered, tmpDirFor, writeState } from "./state";
import { pushZip, uploadSnapshot } from "./sync";

const DONE = /\]: Done \(\d/;
const SAVED = /Saved the game/;
const CHUNKY_DONE = /\[Chunky\] Task finished for minecraft:overworld/;
/** 129/130/143: Java stopped by a closed window, Ctrl+C or SIGTERM, which is a normal stop. */
const NORMAL_EXIT = new Set([0, 129, 130, 143]);

const isLeaseProblem = (err: unknown): err is Error => err instanceof LeaseLostError || err instanceof StaleRevError;

export async function runHosted(deps: SessionDeps, p: Prepared): Promise<void> {
  const st = {
    baseRev: p.baseRev,
    pregenDone: p.pregenDone,
    lost: null as string | null,
    stopping: false,
    saving: null as Promise<void> | null,
  };
  const startedAt = deps.now();
  await writeState(deps.dataDir, { worldId: p.world.id, baseRev: st.baseRev, dirty: true });

  const server = deps.launch(p.serverDir, p.marker, p.javaBin);
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
  // Stays installed until the very end, so Ctrl+C during the final upload can't abandon it.
  const unhookStop = deps.onStopSignal(() => stop("Stopping the server and saving the world. This can take a minute…"));
  p.unhook();
  // Runs until the final upload and release are done, not just while Java runs.
  let stopHeartbeat = () => {};
  try {
    deps.forwardInput((line) => con.send(line));

    const loseLease = (err: Error) => {
      if (st.lost) return;
      st.lost = err.message;
      con.send("say [mc-host] Someone else took over hosting. This server is stopping, and its world won't be saved to the cloud.");
      stop();
    };

    con.onLine((line) => {
      if (DONE.test(line)) {
        deps.log(`Hosting ${p.world.name}. Players connect to ${p.address}:25565`);
        if (!st.pregenDone) {
          if (p.baseRev === 0) {
            con.send(`chunky radius ${PREGEN_RADIUS}`);
            con.send("chunky start");
          } else {
            con.send("chunky continue");
          }
        }
      }
      if (CHUNKY_DONE.test(line)) st.pregenDone = true;
    });

    stopHeartbeat = deps.timers.every(HEARTBEAT_MS, () => {
      deps.api.heartbeat(p.sessionId).catch((err) => {
        if (isLeaseProblem(err)) loseLease(err);
      });
    });
    p.stopHeartbeat();

    const autosave = async () => {
      const file = join(tmpDirFor(deps.dataDir), "autosave.zip");
      try {
        const zipped = await (async () => {
          try {
            con.send("save-off");
            con.send("save-all flush");
            await con.waitFor(SAVED, SAVE_TIMEOUT_MS);
            return await zipSnapshot(p.serverDir, p.levelName, file);
          } finally {
            if (!st.stopping) con.send("save-on");
          }
        })();
        // Upload after save-on, so play isn't paused while it runs.
        st.baseRev = await pushZip(deps, { sessionId: p.sessionId, baseRev: st.baseRev, pregenDone: st.pregenDone }, file, zipped);
        await writeState(deps.dataDir, { worldId: p.world.id, baseRev: st.baseRev, dirty: true });
        deps.log(`Autosaved as rev ${st.baseRev}.`);
      } catch (err) {
        if (isLeaseProblem(err)) return loseLease(err);
        deps.log(`Warning: ${(err as Error).message} The server keeps running, and the next autosave tries again.`);
        con.send("say [mc-host] Couldn't back up the world to the cloud. Still trying.");
      } finally {
        await rm(file, { force: true });
      }
    };
    const stopAutosave = deps.timers.every(AUTOSAVE_MS, () => {
      if (st.stopping || st.saving) return;
      st.saving = autosave().finally(() => {
        st.saving = null;
      });
    });

    const code = await server.exited;
    stopAutosave();
    deps.forwardInput(null);
    if (st.saving) await st.saving;

    if (st.lost) return await setAside(deps, p, st.baseRev, st.lost);
    if (NORMAL_EXIT.has(code)) return await finalUpload(deps, p, st);
    return await crashed(deps, p, st, code, startedAt);
  } finally {
    stopHeartbeat();
    unhookStop();
  }
}

async function setAside(deps: SessionDeps, p: Prepared, baseRev: number, why: string): Promise<never> {
  const dest = await moveToRecovered(deps.dataDir, p.world.id, deps.now());
  await writeState(deps.dataDir, { worldId: p.world.id, baseRev, dirty: false });
  throw new UserError(`${why} Your copy of the world was moved to ${dest}.`);
}

async function finalUpload(deps: SessionDeps, p: Prepared, st: { baseRev: number; pregenDone: boolean }): Promise<void> {
  deps.log("Uploading the world…");
  try {
    st.baseRev = await uploadSnapshot(deps, {
      sessionId: p.sessionId,
      baseRev: st.baseRev,
      serverDir: p.serverDir,
      levelName: p.levelName,
      pregenDone: st.pregenDone,
    });
  } catch (err) {
    if (isLeaseProblem(err)) return setAside(deps, p, st.baseRev, err.message);
    // Keep the lease and the dirty flag: the next `mc-host start` offers this upload again.
    throw new UserError("Couldn't upload the world. Run `mc-host start` again when you're back online. Your progress is saved on this PC.");
  }
  await writeState(deps.dataDir, { worldId: p.world.id, baseRev: st.baseRev, dirty: false });
  await deps.api
    .release(p.sessionId)
    .catch((err) => deps.log(`Couldn't release the lease (${(err as Error).message}). It frees itself within 10 minutes.`));
  deps.log(`World saved as rev ${st.baseRev}. Hosting has stopped.`);
}

async function crashed(
  deps: SessionDeps,
  p: Prepared,
  st: { baseRev: number; pregenDone: boolean },
  code: number,
  startedAt: number,
): Promise<never> {
  deps.log(await deps.crashSummary(p.serverDir, startedAt));
  if (yes(await deps.ask("The server crashed. Upload the world as it is? [y/N] "), false)) {
    try {
      st.baseRev = await uploadSnapshot(deps, {
        sessionId: p.sessionId,
        baseRev: st.baseRev,
        serverDir: p.serverDir,
        levelName: p.levelName,
        pregenDone: st.pregenDone,
      });
      deps.log(`Uploaded as rev ${st.baseRev}.`);
    } catch (err) {
      deps.log(`Couldn't upload it: ${(err as Error).message}`);
    }
  }
  const dest = await moveToRecovered(deps.dataDir, p.world.id, deps.now());
  await writeState(deps.dataDir, { worldId: p.world.id, baseRev: st.baseRev, dirty: false });
  await deps.api.release(p.sessionId).catch(() => {});
  throw new UserError(`The server crashed (exit code ${code}). A copy of the world is in ${dest}. Run mc-host start to host again.`);
}
