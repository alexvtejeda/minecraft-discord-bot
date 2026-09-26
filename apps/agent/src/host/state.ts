import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserError } from "@mc/profile";

/** `dirty`: this PC's copy of the world may be newer than the cloud's (the server ran since the last committed stop). */
export interface LocalState {
  worldId: string;
  baseRev: number;
  dirty: boolean;
}

export const serverDirFor = (dataDir: string, worldId: string) => join(dataDir, worldId, "server");
export const tmpDirFor = (dataDir: string) => join(dataDir, "tmp");

export async function readState(dataDir: string): Promise<LocalState | null> {
  const path = join(dataDir, "state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as LocalState;
  } catch {
    throw new UserError(`${path} is damaged. Move it somewhere else, then run mc-host start again.`);
  }
}

/** Write via a temp file and rename, so a crash mid-write never leaves half a file. */
export async function writeState(dataDir: string, state: LocalState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "state.json");
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

export function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Move the world's server folder to recovered/<stamp>-<worldId>. Returns null if there was nothing to move. */
export async function moveToRecovered(dataDir: string, worldId: string, now: number): Promise<string | null> {
  const src = serverDirFor(dataDir, worldId);
  if (!existsSync(src)) return null;
  const dest = join(dataDir, "recovered", `${stamp(now)}-${worldId}`);
  await mkdir(dirname(dest), { recursive: true });
  await rename(src, dest);
  return dest;
}

export async function lastSaveTime(serverDir: string, levelName: string): Promise<number | null> {
  const st = await stat(join(serverDir, levelName, "level.dat")).catch(() => null);
  return st ? st.mtimeMs : null;
}
