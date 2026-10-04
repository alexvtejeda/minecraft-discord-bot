import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { extractZip, zipTree } from "../host/snapshot";
import { stamp } from "../host/state";

export const lobbyRoot = (dataDir: string) => join(dataDir, "lobby");
export const lobbyServerDir = (dataDir: string) => join(lobbyRoot(dataDir), "server");

/** Downloaded again or rebuilt by Paper on every start, so never backed up. */
export const NOT_BACKED_UP = [
  "cache",
  "libraries",
  "versions",
  "logs",
  "crash-reports",
  "paper.jar",
  "plugins/.paper-remapped",
  "plugins/lobby-bridge.jar",
];
export const notBackedUp = (rel: string): boolean => NOT_BACKED_UP.some((p) => rel === p || rel.startsWith(`${p}/`));

export async function zipLobby(dir: string, outFile: string): Promise<{ sha256: string; size: number }> {
  const tops = (await readdir(dir)).filter((name) => !notBackedUp(name)).sort();
  return zipTree(dir, tops, outFile, notBackedUp);
}

/** Replace dir with the backup's contents, once its sha256 checks out. */
export async function restoreLobby(zipFile: string, dir: string, sha256: string): Promise<void> {
  await extractZip(zipFile, dir, sha256, {
    what: "lobby backup",
    allowTop: (top) => !notBackedUp(top),
    clear: () => rm(dir, { recursive: true, force: true }),
  });
}

/** `sessionId`: this machine's last lobby session. `backupRev`: the backup this folder was restored from or last saved as. */
export interface LobbyState {
  sessionId?: string;
  backupRev: number;
}

const statePath = (dataDir: string) => join(lobbyRoot(dataDir), "state.json");

export async function readLobbyState(dataDir: string): Promise<LobbyState> {
  const path = statePath(dataDir);
  if (!existsSync(path)) return { backupRev: 0 };
  try {
    return JSON.parse(await readFile(path, "utf8")) as LobbyState;
  } catch {
    throw new UserError(`${path} is damaged. Delete it, then start the lobby again.`);
  }
}

/** Write via a temp file and rename, so a crash mid-write never leaves half a file. */
export async function writeLobbyState(dataDir: string, state: LobbyState): Promise<void> {
  await mkdir(lobbyRoot(dataDir), { recursive: true });
  const path = statePath(dataDir);
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

/** Move this machine's lobby folder to lobby/old-<stamp>. Returns null when there was none. */
export async function moveLobbyAside(dataDir: string, now: number): Promise<string | null> {
  const src = lobbyServerDir(dataDir);
  if (!existsSync(src)) return null;
  const dest = join(lobbyRoot(dataDir), `old-${stamp(now)}`);
  await rename(src, dest);
  return dest;
}
