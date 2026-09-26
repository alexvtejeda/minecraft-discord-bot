import { beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoot, type BootOptions } from "../src/packs/boot";
import { MARKER } from "./host-fakes";

let root: string;
let o: BootOptions;
const PACK = "afk display v1.1.17 (MC 26.2).zip";

/** A fake java: prints what it's told, from the server folder, like the real one. */
function java(...script: string[]) {
  const path = join(root, "java");
  writeFileSync(path, ["#!/bin/sh", ...script].join("\n") + "\n");
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-boot-"));
  mkdirSync(join(root, "server"));
  mkdirSync(join(root, "packs"));
  writeFileSync(join(root, "packs", PACK), "zip");
  o = { serverDir: join(root, "server"), levelName: "check", packsDir: join(root, "packs"), javaBin: join(root, "java"), marker: MARKER, logsDir: join(root, "logs") };
});

const LIST = `echo "[10:00:00] [main/INFO]: packs: $(ls check/datapacks | tr '\\n' ',')"`;
const DONE = `echo '[10:00:01] [Server thread/INFO]: Done (1.0s)! For help, type "help"'`;

// Review focus 2
test("copies the packs into a fresh world, stops the server after Done, and keeps the log", async () => {
  java(LIST, DONE, "read cmd", 'echo "[10:00:02] [Server thread/INFO]: got $cmd"');
  const boot = createBoot(o);
  const r = await boot([PACK], "all");
  expect(r.started).toBe(true);
  expect(r.lines).toContain(`[10:00:00] [main/INFO]: packs: ${PACK},`);
  expect(r.lines).toContain("[10:00:02] [Server thread/INFO]: got stop");
  expect(readFileSync(join(root, "logs", "01-all.log"), "utf8")).toContain("got stop");
});

test("wipes the world between boots", async () => {
  java(LIST, DONE, "read cmd");
  const boot = createBoot(o);
  await boot([PACK], "all");
  writeFileSync(join(o.serverDir, "check", "level.dat"), "old world");
  const r = await boot([], "baseline");
  expect(r.lines).toContain("[10:00:00] [main/INFO]: packs: ");
  expect(existsSync(join(o.serverDir, "check", "level.dat"))).toBe(false);
  expect(existsSync(join(root, "logs", "02-baseline.log"))).toBe(true);
});

test("a server that exits before Done didn't start, and its last lines are kept", async () => {
  java('echo "[10:00:01] [Worker-Main-2/ERROR]: Registry loading errors:"', "exit 1");
  const r = await createBoot(o)([PACK], "all");
  expect(r).toEqual({ lines: ["[10:00:01] [Worker-Main-2/ERROR]: Registry loading errors:"], started: false });
});

// Review focus 3
test("a server that never reaches Done is killed", async () => {
  java('echo "[10:00:00] [main/INFO]: loading"', "exec sleep 30");
  const r = await createBoot({ ...o, startTimeoutMs: 200 })([], "baseline");
  expect(r.started).toBe(false);
  expect(r.lines.at(-1)).toBe("mc-host: the server didn't finish starting in time, so it was stopped.");
});

// Review focus 3
test("a server that ignores stop is killed", async () => {
  java(DONE, "exec sleep 30");
  const r = await createBoot({ ...o, stopTimeoutMs: 200 })([], "baseline");
  expect(r.started).toBe(true);
  expect(r.lines.at(-1)).toBe("mc-host: the server didn't stop in time, so it was killed.");
});
