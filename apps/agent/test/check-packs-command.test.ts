import { beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { parseProfile, profileHash, serializeLock } from "@mc/profile";
import { runCommand, type Deps } from "../src/commands";

const enc = (s: string) => new TextEncoder().encode(s);
const GOOD = "good pack v1.0 (MC 26.2).zip";
const BAD = "bad pack v1.0 (MC 26.2).zip";

/** A fake java that behaves like 26.3 with a pack whose loot table points at a missing one. */
const JAVA = [
  "#!/bin/sh",
  `if [ "$1" = "-version" ]; then echo 'openjdk version "25.0.4" 2026-07-21' >&2; exit 0; fi`,
  `echo "[10:00:00] [Worker-Main-1/ERROR]: No key layers in MapLike[{}]"`,
  "if ls check/datapacks | grep -q '^bad'; then",
  `  echo "[10:00:01] [Worker-Main-2/ERROR]: Registry loading errors:"`,
  `  echo "java.lang.IllegalStateException: Unbound values in registry ResourceKey[minecraft:root / minecraft:loot_table]: [ghost:entities/player]"`,
  `  echo "[10:00:01] [main/WARN]: Failed to load datapacks, can't proceed with server load. You can either fix your datapacks or reset to vanilla with --safeMode"`,
  "  exit 1",
  "fi",
  `echo '[10:00:02] [Server thread/INFO]: Done (1.0s)! For help, type "help"'`,
  "read line",
].join("\n");

let dir: string;
let packsDir: string;
let scratch: string;
let lines: string[];
let deps: Deps;

/** A profile plus a matching lockfile with no mod files, so the build only fetches the launcher. */
async function writeProfile(datapacks: string[]) {
  const raw = {
    name: "test",
    description: "t",
    minecraft: "26.3",
    loader: { fabric: "latest-stable" },
    memory: { min: "1G", max: "1G" },
    mods: [{ modrinth: "lithium", side: "server" }],
    datapacks,
  };
  writeFileSync(join(dir, "test.json"), JSON.stringify(raw, null, 2));
  const profile = parseProfile(raw, "test.json");
  writeFileSync(
    join(dir, "test.lock.json"),
    serializeLock({
      lockfileVersion: 1,
      profile: "test",
      profileHash: await profileHash(profile),
      minecraft: "26.3",
      javaMajor: 25,
      fabricLoader: "0.19.5",
      fabricInstaller: "1.1.2",
      files: [],
    }),
  );
}

const check = (o: { all?: boolean; keep?: boolean } = {}) =>
  runCommand({ kind: "check-packs", name: "test", packsDir, all: o.all ?? false, keep: o.keep ?? false, profilesDir: dir }, deps);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-checkcmd-"));
  packsDir = join(dir, "packs");
  scratch = join(dir, "cache", "check-packs", "test");
  lines = [];
  mkdirSync(packsDir);
  writeFileSync(join(packsDir, GOOD), zipSync({ "pack.mcmeta": enc("{}"), "data/good/function/hi.mcfunction": enc("say hi") }, { level: 0 }));
  writeFileSync(join(packsDir, BAD), zipSync({ "pack.mcmeta": enc("{}"), "data/bad/loot_table/x.json": enc('{"value":"ghost:entities/player"}') }, { level: 0 }));
  writeFileSync(join(packsDir, "notes.txt"), "not a pack");
  writeFileSync(join(dir, "java"), JAVA + "\n");
  chmodSync(join(dir, "java"), 0o755);
  deps = {
    fetch: async (url) => (url.endsWith("/server/jar") ? new Response("launcher") : new Response("no", { status: 404 })),
    cacheDir: join(dir, "cache"),
    configDir: join(dir, "config"),
    log: (l) => void lines.push(l),
    ask: async () => "yes",
    javaBin: join(dir, "java"),
  };
  await writeProfile(["vt:good-pack"]);
});

// Review focus 2
test("--all fails the pack that breaks the server, passes the rest and cleans up", async () => {
  await expect(check({ all: true })).rejects.toThrow("1 of 2 datapacks have errors (3 boots).");
  const out = lines.join("\n");
  expect(out).toContain("Checking 2 datapacks against test (Minecraft 26.3)…");
  expect(out).toContain(`  FAIL  ${BAD}\n        java.lang.IllegalStateException: Unbound values in registry`);
  expect(out).toContain(`  ok    ${GOOD}`);
  expect(existsSync(join(scratch, "check"))).toBe(false);
  expect(existsSync(join(scratch, "fabric-server-launch.jar"))).toBe(true);
});

test("without --all only the profile's datapacks are checked", async () => {
  await check();
  expect(lines).toContain("Checking 1 datapacks against test (Minecraft 26.3)…");
  expect(lines.at(-1)).toBe("The datapack loaded without errors (2 boots).");
});

test("--keep keeps the test world and one log per boot", async () => {
  await expect(check({ all: true, keep: true })).rejects.toThrow("have errors");
  expect(readdirSync(join(scratch, "check-logs")).sort()).toEqual(["01-baseline.log", "02-all.log", "03-all.log"]);
  expect(existsSync(join(scratch, "check", "datapacks", GOOD))).toBe(true);
  expect(lines).toContain(`The test world and the boot logs are in ${scratch}.`);
});

test("a profile without datapacks needs --all, and missing zips are named", async () => {
  await writeProfile([]);
  await expect(check()).rejects.toThrow(`test has no datapacks. Add --all to check every zip in ${packsDir}.`);
  await writeProfile(["vt:gone"]);
  await expect(check()).rejects.toThrow(`These datapacks aren't in ${packsDir}: vt:gone.`);
});

test("declining the EULA stops before anything is built", async () => {
  deps.ask = async () => "no";
  await expect(check({ all: true })).rejects.toThrow("You need to agree to the EULA to check datapacks.");
  expect(existsSync(join(scratch, "fabric-server-launch.jar"))).toBe(false);
});

// Final review 3
test("the test server gets its own port, and a failed check keeps its logs", async () => {
  await expect(check({ all: true })).rejects.toThrow("have errors");
  const port = /^server-port=(\d+)$/m.exec(readFileSync(join(scratch, "server.properties"), "utf8"))?.[1];
  expect(port).toBeDefined();
  expect(port).not.toBe("25565");
  expect(readdirSync(join(scratch, "check-logs")).length).toBe(3);
  expect(lines).toContain(`The boot logs are in ${join(scratch, "check-logs")}.`);
  expect(existsSync(join(scratch, "check"))).toBe(false);
});
