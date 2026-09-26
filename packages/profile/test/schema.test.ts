import { describe, expect, test } from "bun:test";
import { parseProfile, toMegabytes } from "../src/schema";

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
