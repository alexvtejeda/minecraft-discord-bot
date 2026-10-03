import { describe, expect, test } from "bun:test";
import { profileHash } from "../src/lockfile";
import { isJarEntry, modName, parseProfile, toMegabytes } from "../src/schema";

const base = {
  name: "test",
  description: "t",
  minecraft: "26.3",
  loader: { fabric: "latest-stable" },
  memory: { min: "2G", max: "4G" },
  mods: [{ modrinth: "lithium", side: "server" }],
};

describe("parseProfile", () => {
  test("accepts a minimal profile and fills defaults", () => {
    const p = parseProfile(base, "test.json");
    expect(p.waiting).toEqual([]);
    expect(p.datapacks).toEqual([]);
    expect(p.properties).toEqual({});
    expect(p.resourcePack).toBeUndefined();
  });

  test("reports a bad side with its path and the file name", () => {
    const bad = { ...base, mods: [{ modrinth: "lithium", side: "client" }] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/test\.json has problems[\s\S]*mods\.0\.side/);
  });

  test("rejects unknown keys such as a typo", () => {
    expect(() => parseProfile({ ...base, mod: [] }, "test.json")).toThrow(/Unrecognized key/);
  });

  test("rejects a mod listed twice", () => {
    const bad = { ...base, mods: [base.mods[0], base.mods[0]] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/"lithium" is listed twice/);
  });

  test("rejects a mod that is in both mods and waiting", () => {
    expect(() => parseProfile({ ...base, waiting: ["lithium"] }, "test.json")).toThrow(/both "mods" and "waiting"/);
  });

  test("rejects clientOptional on a side other than both", () => {
    const bad = { ...base, mods: [{ modrinth: "lithium", side: "server", clientOptional: true }] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/mods\.0\.clientOptional/);
  });

  test("rejects min memory larger than max", () => {
    expect(() => parseProfile({ ...base, memory: { min: "8G", max: "4G" } }, "test.json")).toThrow(/memory\.min/);
  });

  test("rejects a bad datapack id", () => {
    expect(() => parseProfile({ ...base, datapacks: ["AFK Display"] }, "test.json")).toThrow(/datapacks\.0/);
  });
});

test("toMegabytes", () => {
  expect(toMegabytes("2G")).toBe(2048);
  expect(toMegabytes("512M")).toBe(512);
});

const SHA = "a".repeat(128);
const jarEntry = { jar: "dragonbond", filename: "the-deeper-end-fabric-1.1.1.jar", sha512: SHA, side: "both" };

describe("jar entries", () => {
  test("parse next to modrinth entries", () => {
    const p = parseProfile({ ...base, mods: [...base.mods, jarEntry] }, "test.json");
    expect(p.mods.map(modName)).toEqual(["lithium", "dragonbond"]);
    expect(isJarEntry(p.mods[1]!)).toBe(true);
  });

  test("accept a file name with spaces", () => {
    const e = { ...jarEntry, filename: "antiquetradingship-1.0.0 Fabric 26.3.jar" };
    expect(() => parseProfile({ ...base, mods: [e] }, "test.json")).not.toThrow();
  });

  test("report jar mistakes against the jar's own fields", () => {
    const bad = { ...base, mods: [{ ...jarEntry, side: "client-optional" }] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/mods\.0\.side: must be "server" or "both"/);
    expect(() => parseProfile({ ...base, mods: [{ ...jarEntry, sha512: "abc" }] }, "test.json")).toThrow(/mods\.0\.sha512/);
    expect(() => parseProfile({ ...base, mods: [{ ...jarEntry, filename: "../x.jar" }] }, "test.json")).toThrow(/mods\.0\.filename/);
    expect(() => parseProfile({ ...base, mods: [{ ...jarEntry, clientOptional: true }] }, "test.json")).toThrow(/Unrecognized key/);
  });

  // Review focus 1: the per-key schema keeps modrinth errors precise.
  test("a modrinth entry's bad side still names mods.0.side", () => {
    const bad = { ...base, mods: [{ modrinth: "lithium", side: "client" }] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/mods\.0\.side/);
  });

  test("names are unique across modrinth, jar and waiting", () => {
    const dup = { ...base, mods: [...base.mods, { ...jarEntry, jar: "lithium" }] };
    expect(() => parseProfile(dup, "test.json")).toThrow(/"lithium" is listed twice/);
    expect(() => parseProfile({ ...base, mods: [jarEntry], waiting: ["dragonbond"] }, "test.json")).toThrow(/both "mods" and "waiting"/);
  });

  // Review focus 2: existing lockfiles keep matching.
  test("a modrinth-only profile hashes the same as before the union", async () => {
    const p = parseProfile({ ...base, mods: [{ modrinth: "lithium", side: "both", clientOptional: true, version: "x" }] }, "t.json");
    expect(JSON.stringify(p.mods[0])).toBe('{"modrinth":"lithium","side":"both","clientOptional":true,"version":"x"}');
    expect(await profileHash(p)).toMatch(/^[0-9a-f]{64}$/);
  });
});
