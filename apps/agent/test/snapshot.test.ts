import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { ChecksumError, extractSnapshot, sha256File, snapshotPaths, zipSnapshot } from "../src/host/snapshot";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-snap-"));
});

function put(dir: string, rel: string, data: string | Uint8Array) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), data);
}

function listAll(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listAll(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}

function server(dir: string, levelName = "world") {
  const region = crypto.getRandomValues(new Uint8Array(200_000));
  put(dir, `${levelName}/level.dat`, "level");
  put(dir, `${levelName}/region/r.0.0.mca`, region);
  put(dir, `${levelName}/session.lock`, "locked");
  put(dir, "config/chunky/tasks.properties", "radius=2000");
  put(dir, "ops.json", "[]");
  put(dir, "usercache.json", "[]");
  put(dir, "mods/lithium.jar", "jar");
  put(dir, "logs/latest.log", "log");
  put(dir, "server.properties", "motd=x");
  return region;
}

test("snapshot paths follow the level name", () => {
  expect(snapshotPaths("adventure")).toEqual(["adventure", "config", "ops.json", "banned-players.json", "banned-ips.json", "usercache.json"]);
});

test("zip → extract round-trips exactly the snapshot paths, without session.lock", async () => {
  const src = join(root, "src");
  const region = server(src);
  const zip = join(root, "out", "snap.zip");
  const { sha256, size } = await zipSnapshot(src, "world", zip);
  expect(sha256).toBe(await sha256File(zip));
  expect(size).toBe(statSync(zip).size);

  const dest = join(root, "dest");
  await extractSnapshot(zip, dest, "world", sha256);
  expect(listAll(dest)).toEqual([
    "config/chunky/tasks.properties",
    "ops.json",
    "usercache.json",
    "world/level.dat",
    "world/region/r.0.0.mca",
  ]);
  expect(new Uint8Array(readFileSync(join(dest, "world/region/r.0.0.mca")))).toEqual(region);
});

test("a custom level-name is zipped and extracted under its own folder", async () => {
  const src = join(root, "src");
  server(src, "adventure");
  const zip = join(root, "snap.zip");
  const { sha256 } = await zipSnapshot(src, "adventure", zip);
  const dest = join(root, "dest");
  await extractSnapshot(zip, dest, "adventure", sha256);
  expect(existsSync(join(dest, "adventure/level.dat"))).toBe(true);
  expect(existsSync(join(dest, "world"))).toBe(false);
});

test("extract clears stale snapshot paths but leaves the rest of the server alone", async () => {
  const src = join(root, "src");
  server(src);
  const zip = join(root, "snap.zip");
  const { sha256 } = await zipSnapshot(src, "world", zip);
  const dest = join(root, "dest");
  put(dest, "world/region/r.9.9.mca", "stale");
  put(dest, "mods/keep.jar", "jar");
  await extractSnapshot(zip, dest, "world", sha256);
  expect(existsSync(join(dest, "world/region/r.9.9.mca"))).toBe(false);
  expect(existsSync(join(dest, "mods/keep.jar"))).toBe(true);
});

test("a checksum mismatch is rejected before anything is touched", async () => {
  const src = join(root, "src");
  server(src);
  const zip = join(root, "snap.zip");
  await zipSnapshot(src, "world", zip);
  const dest = join(root, "dest");
  put(dest, "world/level.dat", "mine");
  await expect(extractSnapshot(zip, dest, "world", "0".repeat(64))).rejects.toBeInstanceOf(ChecksumError);
  expect(readFileSync(join(dest, "world/level.dat"), "utf8")).toBe("mine");
});

test("entries outside the snapshot paths are refused", async () => {
  for (const name of ["../evil.txt", "mods/evil.jar"]) {
    const zip = join(root, `bad-${name.length}.zip`);
    writeFileSync(zip, zipSync({ [name]: new TextEncoder().encode("x") }));
    await expect(extractSnapshot(zip, join(root, "dest"), "world", await sha256File(zip))).rejects.toThrow("unsafe");
  }
});
