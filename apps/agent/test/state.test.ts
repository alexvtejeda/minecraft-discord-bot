import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastSaveTime, moveToRecovered, readState, serverDirFor, stamp, writeState } from "../src/host/state";

const dir = () => mkdtempSync(join(tmpdir(), "mc-state-"));

test("state round-trips and is null when missing", async () => {
  const d = dir();
  expect(await readState(d)).toBeNull();
  await writeState(d, { worldId: "w1", baseRev: 3, dirty: true });
  expect(await readState(d)).toEqual({ worldId: "w1", baseRev: 3, dirty: true });
});

test("a damaged state file is reported", async () => {
  const d = dir();
  writeFileSync(join(d, "state.json"), "{");
  await expect(readState(d)).rejects.toThrow("is damaged");
});

test("stamp is a sortable local timestamp", () => {
  expect(stamp(new Date(2026, 8, 26, 20, 4, 5).getTime())).toBe("2026-09-26_20-04-05");
});

test("moveToRecovered moves the world's server folder aside", async () => {
  const d = dir();
  const server = serverDirFor(d, "w1");
  mkdirSync(join(server, "world"), { recursive: true });
  writeFileSync(join(server, "world", "level.dat"), "x");
  const dest = await moveToRecovered(d, "w1", new Date(2026, 8, 26, 20, 4, 5).getTime());
  expect(dest).toBe(join(d, "recovered", "2026-09-26_20-04-05-w1"));
  expect(readFileSync(join(dest!, "world", "level.dat"), "utf8")).toBe("x");
  expect(existsSync(server)).toBe(false);
  expect(await moveToRecovered(d, "w1", 0)).toBeNull();
});

test("lastSaveTime reads level.dat under the level name", async () => {
  const d = dir();
  mkdirSync(join(d, "adventure"));
  writeFileSync(join(d, "adventure", "level.dat"), "x");
  const t = new Date(2026, 8, 26, 14, 32);
  utimesSync(join(d, "adventure", "level.dat"), t, t);
  expect(await lastSaveTime(d, "adventure")).toBe(t.getTime());
  expect(await lastSaveTime(d, "world")).toBeNull();
});
