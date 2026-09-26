import { beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha512Hex, type Fetch, type LockEntry, type Lockfile } from "@mc/profile";
import { makeProfile } from "../../../packages/profile/test/fakes";
import { buildServer, LAUNCHER_JAR, MARKER, readMarker } from "../src/server/build";

let root: string;
let serverDir: string;
let packsDir: string;
let cache: string;
const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-build-"));
  serverDir = join(root, "server");
  packsDir = join(root, "packs");
  cache = join(root, "cache");
  mkdirSync(packsDir);
  writeFileSync(join(packsDir, "afk display v1.1.17 (MC 26.2).zip"), "zip");
});

async function entry(slug: string, side: LockEntry["side"]): Promise<LockEntry> {
  return {
    slug,
    projectId: slug,
    versionId: "v",
    versionNumber: "1",
    filename: `${slug}.jar`,
    url: `https://cdn.test/${slug}.jar`,
    sha1: "x",
    sha512: await sha512Hex(bytes(slug)),
    size: slug.length,
    side,
    clientOptional: false,
    auto: false,
    prerelease: false,
  };
}

async function makeLock(): Promise<Lockfile> {
  return {
    lockfileVersion: 1,
    profile: "test",
    profileHash: "h",
    minecraft: "26.3",
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files: [await entry("lithium", "server"), await entry("waystones", "both"), await entry("sodium", "client-optional")],
  };
}

const fetch: Fetch = async (url) => {
  if (url.endsWith("/server/jar")) return new Response(bytes("launcher"));
  const slug = url.split("/").pop()!.replace(".jar", "");
  return new Response(bytes(slug));
};

const profile = makeProfile({ properties: { difficulty: "hard" }, datapacks: ["vt:afk-display"] });

test("builds launcher, server-side mods, properties, datapacks and marker", async () => {
  const result = await buildServer({ profile, lock: await makeLock(), dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" });
  expect(readFileSync(join(serverDir, LAUNCHER_JAR), "utf8")).toBe("launcher");
  expect(readdirSync(join(serverDir, "mods")).sort()).toEqual(["lithium.jar", "waystones.jar"]);
  expect(result.mods).toEqual(["lithium.jar", "waystones.jar"]);
  expect(readFileSync(join(serverDir, "server.properties"), "utf8")).toContain("difficulty=hard");
  expect(existsSync(join(serverDir, "world", "datapacks", "afk display v1.1.17 (MC 26.2).zip"))).toBe(true);
  expect(existsSync(join(serverDir, "eula.txt"))).toBe(false);
  expect(existsSync(join(serverDir, MARKER))).toBe(true);
  expect(await readMarker(serverDir)).toEqual({ profile: "test", minecraft: "26.3", javaMajor: 25, memory: { min: "2G", max: "4G" }, complete: true });
});

// Review focus 4
test("removes jars the lockfile no longer lists, keeps config files", async () => {
  const lock = await makeLock();
  await buildServer({ profile, lock, dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" });
  writeFileSync(join(serverDir, "mods", "config-note.txt"), "keep me");
  lock.files = lock.files.filter((f) => f.slug !== "waystones");
  const result = await buildServer({ profile, lock, dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" });
  expect(result.removed).toEqual(["waystones.jar"]);
  expect(readdirSync(join(serverDir, "mods")).sort()).toEqual(["config-note.txt", "lithium.jar"]);
});

test("never touches datapacks of an existing world", async () => {
  mkdirSync(join(serverDir, "world"), { recursive: true });
  const result = await buildServer({ profile, lock: await makeLock(), dir: serverDir, fetch, cacheDir: cache, userAgent: "ua" });
  expect(result.datapacks).toEqual([]);
  expect(existsSync(join(serverDir, "world", "datapacks"))).toBe(false);
});

// Review focus 5
test("missing packs fail before a world folder is created", async () => {
  const p = makeProfile({ datapacks: ["vt:afk-display", "vt:ghost"] });
  await expect(buildServer({ profile: p, lock: await makeLock(), dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(
    /These datapacks aren't in .*: vt:ghost/,
  );
  expect(existsSync(join(serverDir, "world"))).toBe(false);
});

test("asks for --packs when datapacks are needed and none were given", async () => {
  await expect(buildServer({ profile, lock: await makeLock(), dir: serverDir, fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(/--packs/);
});

test("rejects a lockfile filename that escapes mods/", async () => {
  const lock = await makeLock();
  lock.files[0]!.filename = "../evil.jar";
  await expect(buildServer({ profile, lock, dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(/Unsafe file name/);
});

test("readMarker explains a folder that was not built by mc-host", async () => {
  await expect(readMarker(root)).rejects.toThrow(/isn't a server folder built by mc-host/);
});

// Final review I1
test("a failed download leaves the existing server folder untouched", async () => {
  const lock = await makeLock();
  await buildServer({ profile, lock, dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" });
  const updated = await makeLock();
  updated.files[1] = { ...updated.files[1]!, filename: "waystones-2.jar", url: "https://cdn.test/waystones-2.jar", sha512: await sha512Hex(bytes("waystones-2")) };
  const offline: Fetch = async (url) => (url.includes("waystones-2") ? new Response("", { status: 503 }) : fetch(url));
  await expect(buildServer({ profile, lock: updated, dir: serverDir, packsDir, fetch: offline, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(/Couldn't download/);
  expect(readdirSync(join(serverDir, "mods")).sort()).toEqual(["lithium.jar", "waystones.jar"]);
  expect((await readMarker(serverDir)).complete).toBe(true);
});

// Final review I2
test("refuses to build a different profile into an existing server folder unless forced", async () => {
  await buildServer({ profile, lock: await makeLock(), dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" });
  const other = makeProfile({ name: "other", datapacks: [] });
  await expect(buildServer({ profile: other, lock: await makeLock(), dir: serverDir, fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(
    /holds the "test" world[\s\S]*--force/,
  );
  expect(readdirSync(join(serverDir, "mods")).sort()).toEqual(["lithium.jar", "waystones.jar"]);
  await buildServer({ profile: other, lock: await makeLock(), dir: serverDir, fetch, cacheDir: cache, userAgent: "ua", force: true });
  expect((await readMarker(serverDir)).profile).toBe("other");
});

test("refuses a folder with jars that mc-host did not put there unless forced", async () => {
  mkdirSync(join(serverDir, "mods"), { recursive: true });
  writeFileSync(join(serverDir, "mods", "handmade.jar"), "x");
  await expect(buildServer({ profile, lock: await makeLock(), dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(
    /already has jars that mc-host didn't put there/,
  );
  expect(existsSync(join(serverDir, "mods", "handmade.jar"))).toBe(true);
});

// Final review I4
test("a --packs folder that does not exist is a plain-English error", async () => {
  await expect(buildServer({ profile, lock: await makeLock(), dir: serverDir, packsDir: join(root, "nope"), fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(
    /The --packs folder .*nope doesn't exist/,
  );
});

test("a mods folder that can't be written says to stop the server", async () => {
  await buildServer({ profile, lock: await makeLock(), dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" });
  const lock = await makeLock();
  lock.files = lock.files.filter((f) => f.slug !== "waystones");
  chmodSync(join(serverDir, "mods"), 0o555);
  try {
    await expect(buildServer({ profile, lock, dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(
      /Stop the server if it's running/,
    );
  } finally {
    chmodSync(join(serverDir, "mods"), 0o755);
  }
});

test("a corrupt marker is a plain-English error", async () => {
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(join(serverDir, MARKER), "{not json");
  await expect(readMarker(serverDir)).rejects.toThrow(/is damaged/);
});
