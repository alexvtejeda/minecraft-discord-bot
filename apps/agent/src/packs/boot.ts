import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { javaCommand, ServerConsole, spawnProcess } from "../host/console";
import type { ServerMarker } from "../server/build";
import type { Boot } from "./check";

export const START_TIMEOUT_MS = 3 * 60_000;
export const STOP_TIMEOUT_MS = 60_000;

export interface BootOptions {
  /** A server folder made by buildServer, with level-name set to levelName. */
  serverDir: string;
  levelName: string;
  packsDir: string;
  javaBin: string;
  marker: ServerMarker;
  /** Each boot's log is written here as <NN>-<label>.log. */
  logsDir: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** Boots the scratch server once per call: fresh world, the given packs, stop at Done. */
export function createBoot(o: BootOptions): Boot {
  let n = 0;
  return async (files, label) => {
    const world = join(o.serverDir, o.levelName);
    await rm(world, { recursive: true, force: true });
    await mkdir(join(world, "datapacks"), { recursive: true });
    for (const f of files) await copyFile(join(o.packsDir, f), join(world, "datapacks", f));

    const proc = spawnProcess(javaCommand(o.marker, o.javaBin), o.serverDir, () => {}, { stderr: "lines" });
    const con = new ServerConsole(proc);
    const lines: string[] = [];
    con.onLine((line) => lines.push(line));
    let exited = false;
    const exit = proc.exited.then(() => {
      exited = true;
    });

    let started = false;
    try {
      await con.waitFor(/Done \(/, o.startTimeoutMs ?? START_TIMEOUT_MS);
      started = true;
      con.send("stop");
      // A timer that's cleared, not Bun.sleep: a pending sleep would keep mc-host running after the check.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exit, new Promise((r) => (timer = setTimeout(r, o.stopTimeoutMs ?? STOP_TIMEOUT_MS)))]);
      clearTimeout(timer);
    } catch {
      // It exited before Done, or never got there; `exited` tells which.
    }
    if (!exited) {
      lines.push(
        started
          ? "mc-host: the server didn't stop in time, so it was killed."
          : "mc-host: the server didn't finish starting in time, so it was stopped.",
      );
      proc.kill();
    }
    await exit;

    await mkdir(o.logsDir, { recursive: true });
    await writeFile(join(o.logsDir, `${String(++n).padStart(2, "0")}-${label}.log`), lines.join("\n") + "\n");
    return { lines, started };
  };
}
