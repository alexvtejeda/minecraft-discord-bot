import { beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLock } from "@mc/profile";
import { FakeModrinth, fakeFabric, fakeMojang } from "../../../packages/profile/test/fakes";
import { runCommand, type Deps } from "../src/commands";

let dir: string;
let lines: string[];
let deps: Deps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-cmd-"));
  lines = [];
  const mr = new FakeModrinth();
  mr.add("lithium", [{}], { client: "optional", server: "optional" });
  mr.add("lootr", [{}], { client: "required", server: "required" });
  mr.add("carry-on", [{ game_versions: ["26.2"] }]);
  deps = {
    fetch: async () => new Response("unused", { status: 500 }),
    cacheDir: join(dir, "cache"),
    configDir: join(dir, "config"),
    log: (l) => void lines.push(l),
    ask: async () => "no",
    clients: { modrinth: mr, fabric: fakeFabric, mojang: fakeMojang },
  };
  writeProfile({});
});

function writeProfile(over: Record<string, unknown>) {
  const profile = {
    name: "test",
    description: "t",
    minecraft: "26.3",
    loader: { fabric: "latest-stable" },
    memory: { min: "2G", max: "4G" },
    mods: [{ modrinth: "lithium", side: "server" }],
    waiting: ["lootr", "carry-on"],
    ...over,
  };
  writeFileSync(join(dir, "test.json"), JSON.stringify(profile, null, 2));
}

test("resolve writes the lockfile and reports waiting mods", async () => {
  await runCommand({ kind: "resolve", name: "test", addReady: false, profilesDir: dir }, deps);
  const lock = parseLock(readFileSync(join(dir, "test.lock.json"), "utf8"), "lock");
  expect(lock.files.map((f) => f.slug)).toEqual(["lithium"]);
  expect(lines.join("\n")).toContain('Now available: lootr. Run "mc-host profile resolve test --add-ready" to add them.');
  expect(lines.join("\n")).toContain("Still waiting: carry-on.");
});

test("--add-ready moves ready mods into the profile with a suggested side", async () => {
  await runCommand({ kind: "resolve", name: "test", addReady: true, profilesDir: dir }, deps);
  const saved = JSON.parse(readFileSync(join(dir, "test.json"), "utf8"));
  expect(saved.mods).toContainEqual({ modrinth: "lootr", side: "both" });
  expect(saved.waiting).toEqual(["carry-on"]);
  const lock = parseLock(readFileSync(join(dir, "test.lock.json"), "utf8"), "lock");
  expect(lock.files.map((f) => f.slug)).toEqual(["lithium", "lootr"]);
});

test("--check reports availability without writing a lockfile", async () => {
  await runCommand({ kind: "resolve", name: "test", check: "26.2", addReady: false, profilesDir: dir }, deps);
  expect(existsSync(join(dir, "test.lock.json"))).toBe(false);
  expect(lines.join("\n")).toContain("carry-on: available (waiting)");
});

// Review focus 3
test("build commands refuse a lockfile that is older than the profile", async () => {
  await runCommand({ kind: "resolve", name: "test", addReady: false, profilesDir: dir }, deps);
  writeProfile({ properties: { difficulty: "hard" } });
  await expect(
    runCommand({ kind: "build-mrpack", name: "test", out: join(dir, "t.mrpack"), profilesDir: dir }, deps),
  ).rejects.toThrow(/test\.json changed since its lockfile was made\. Run "mc-host profile resolve test" first\./);
});

test("build-mrpack writes the pack and says whether it is required", async () => {
  await runCommand({ kind: "resolve", name: "test", addReady: false, profilesDir: dir }, deps);
  await runCommand({ kind: "build-mrpack", name: "test", out: join(dir, "t.mrpack"), profilesDir: dir }, deps);
  expect(existsSync(join(dir, "t.mrpack"))).toBe(true);
  expect(lines.join("\n")).toContain("Vanilla clients can join this world");
});

test("a missing profile lists the ones that exist", async () => {
  await expect(runCommand({ kind: "resolve", name: "nope", addReady: false, profilesDir: dir }, deps)).rejects.toThrow(
    /No profile called "nope"\. Available: test/,
  );
});

test("a missing lockfile says to resolve first", async () => {
  await expect(runCommand({ kind: "build-mrpack", name: "test", out: "x", profilesDir: dir }, deps)).rejects.toThrow(
    /Run "mc-host profile resolve test" first/,
  );
});

test("run refuses when the EULA is declined", async () => {
  const srv = join(dir, "srv");
  await Bun.write(join(srv, ".mc-host.json"), JSON.stringify({ profile: "test", minecraft: "26.3", javaMajor: 8, memory: { min: "1G", max: "1G" }, complete: true }));
  await expect(runCommand({ kind: "run", dir: srv }, deps)).rejects.toThrow(/You need to agree to the EULA/);
});

// Review focus 5
test("run refuses an MC_JAVA that is too old, after the EULA", async () => {
  const srv = join(dir, "srv");
  await Bun.write(join(srv, ".mc-host.json"), JSON.stringify({ profile: "test", minecraft: "26.3", javaMajor: 25, memory: { min: "1G", max: "1G" }, complete: true }));
  const old = join(dir, "java");
  writeFileSync(old, `#!/bin/sh\necho 'openjdk version "21.0.1"' >&2\n`);
  chmodSync(old, 0o755);
  deps.ask = async () => "yes";
  deps.javaBin = old;
  await expect(runCommand({ kind: "run", dir: srv }, deps)).rejects.toThrow("Minecraft 26.3 needs Java 25, but this PC has Java 21");
});

test("run without MC_JAVA downloads Java, and says so when it can't", async () => {
  const srv = join(dir, "srv");
  await Bun.write(join(srv, ".mc-host.json"), JSON.stringify({ profile: "test", minecraft: "26.3", javaMajor: 25, memory: { min: "1G", max: "1G" }, complete: true }));
  deps.ask = async () => "yes";
  await expect(runCommand({ kind: "run", dir: srv }, deps)).rejects.toThrow("Couldn't download Java 25 for this PC (Adoptium answered HTTP 500)");
});

// Final review I1
test("run refuses a folder whose last build did not finish", async () => {
  const srv = join(dir, "srv");
  await Bun.write(join(srv, ".mc-host.json"), JSON.stringify({ profile: "test", minecraft: "26.3", javaMajor: 8, memory: { min: "1G", max: "1G" }, complete: false }));
  await expect(runCommand({ kind: "run", dir: srv }, deps)).rejects.toThrow(/last build of "test" in .* didn't finish/);
});
