import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import type { LockEntry, Lockfile } from "../src/lockfile";
import { buildMrpack, isVanillaCompatible, mrpackIndex } from "../src/mrpack";

function entry(slug: string, side: LockEntry["side"], clientOptional = false): LockEntry {
  return {
    slug,
    projectId: slug.toUpperCase(),
    versionId: `${slug}-v1`,
    versionNumber: "1.0",
    filename: `${slug}.jar`,
    url: `https://cdn.modrinth.com/data/${slug}.jar`,
    sha1: `sha1-${slug}`,
    sha512: `sha512-${slug}`,
    size: 42,
    side,
    clientOptional,
    auto: false,
    prerelease: false,
  };
}

const lock: Lockfile = {
  lockfileVersion: 1,
  profile: "test",
  profileHash: "h",
  minecraft: "26.3",
  javaMajor: 25,
  fabricLoader: "0.19.5",
  fabricInstaller: "1.1.2",
  files: [
    entry("lithium", "server"),
    entry("waystones", "both"),
    entry("voicechat", "both", true),
    entry("sodium", "client-optional", true),
  ],
};

test("index maps sides to env and skips server-only files", async () => {
  const index = await mrpackIndex(lock, { name: "Test", summary: "s" });
  expect(index.formatVersion).toBe(1);
  expect(index.game).toBe("minecraft");
  expect(index.dependencies).toEqual({ minecraft: "26.3", "fabric-loader": "0.19.5" });
  expect(index.versionId).toMatch(/^26\.3-[0-9a-f]{12}$/);
  expect(index.files.map((f) => [f.path, f.env.client, f.env.server])).toEqual([
    ["mods/waystones.jar", "required", "required"],
    ["mods/voicechat.jar", "optional", "required"],
    ["mods/sodium.jar", "optional", "unsupported"],
  ]);
  expect(index.files[0]).toMatchObject({
    hashes: { sha1: "sha1-waystones", sha512: "sha512-waystones" },
    downloads: ["https://cdn.modrinth.com/data/waystones.jar"],
    fileSize: 42,
  });
});

test("the zip holds the index and overrides, and is byte-for-byte reproducible", async () => {
  const extra = { path: "mods/custom.jar", data: new Uint8Array([1, 2, 3]) };
  const a = await buildMrpack(lock, { name: "Test" }, [extra]);
  const b = await buildMrpack(lock, { name: "Test" }, [extra]);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  const files = unzipSync(a);
  expect(Object.keys(files).sort()).toEqual(["modrinth.index.json", "overrides/mods/custom.jar"]);
  expect(JSON.parse(strFromU8(files["modrinth.index.json"]!)).name).toBe("Test");
});

test("rejects override paths that escape the pack", async () => {
  await expect(buildMrpack(lock, { name: "T" }, [{ path: "../evil.jar", data: new Uint8Array() }])).rejects.toThrow(/Bad override path/);
});

test("isVanillaCompatible is false only when a client-required file exists", () => {
  expect(isVanillaCompatible(lock)).toBe(false);
  expect(isVanillaCompatible({ ...lock, files: lock.files.filter((f) => f.slug !== "waystones") })).toBe(true);
});

// Final review I3
test("a client-only file that is required maps to env.client required and blocks vanilla clients", async () => {
  const onlyReq = { ...lock, files: [entry("sodium", "client-optional", true), entry("client-lib", "client-optional", false)] };
  const index = await mrpackIndex(onlyReq, { name: "T" });
  expect(index.files.map((f) => [f.path, f.env.client, f.env.server])).toEqual([
    ["mods/sodium.jar", "optional", "unsupported"],
    ["mods/client-lib.jar", "required", "unsupported"],
  ]);
  expect(isVanillaCompatible(onlyReq)).toBe(false);
});
