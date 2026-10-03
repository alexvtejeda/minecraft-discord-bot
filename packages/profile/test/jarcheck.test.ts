import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { sha512Hex } from "../src/hash";
import { dependencyHints, inspectJar, jarName, jarProfileLine, rangeIncludes } from "../src/jarcheck";

const jar = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const fabric = (o: Record<string, unknown> = {}) =>
  jar({ "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "dragonbond", version: "1.1.1", ...o }) });
const T = { minecraft: "26.3", javaMajor: 25 };

describe("rangeIncludes", () => {
  test.each([
    ["*", "26.3", true],
    ["", "26.3", true],
    ["26.3", "26.3", true],
    ["=26.3", "26.3.0", true],
    ["=26.1.2", "26.3", false],
    [">=26.3", "26.3", true],
    [">26.3", "26.3", false],
    ["<26.4", "26.3", true],
    ["<=26.2", "26.3", false],
    ["~26.3", "26.3.5", true],
    ["~26.3", "26.4", false],
    ["^26.3", "26.9", true],
    ["^26.3", "27.0", false],
    [">=1.14 <=26.3.9", "26.3", true],
    [">= 1.14 <= 26.2", "26.3", false],
    ["26.3.x", "26.3.7", true],
    ["26.2.x", "26.3", false],
    ["=26.1 || =26.3", "26.3", true],
    [">=25", "25", true],
    [">=21", "17", false],
  ])("%p includes %p → %p", (range, version, want) => {
    expect(rangeIncludes(range, version)).toBe(want);
  });

  test("is null when the range can't be read", () => {
    expect(rangeIncludes("26.3-alpha.foo bar!", "26.3")).toBeNull();
    expect(rangeIncludes("@latest", "26.3")).toBeNull();
  });

  test("a false term wins over an unreadable one", () => {
    expect(rangeIncludes("=26.1 @x", "26.3")).toBe(false);
  });
});

describe("inspectJar", () => {
  test("reads id, version, ranges and extra dependencies", async () => {
    const bytes = fabric({ depends: { fabricloader: ">=0.19.5", minecraft: "=26.3", java: ">=25", "fabric-api": "*", citadel: ">=26.3-1.0.0" } });
    const r = await inspectJar(bytes, "the-deeper-end-fabric-1.1.1.jar", T);
    expect(r).toMatchObject({
      filename: "the-deeper-end-fabric-1.1.1.jar",
      modId: "dragonbond",
      version: "1.1.1",
      minecraftRange: "=26.3",
      javaRange: ">=25",
      depends: ["citadel"],
      problems: [],
      size: bytes.length,
    });
    expect(r.sha512).toBe(await sha512Hex(bytes));
    expect(r.sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  test("keeps array ranges as alternatives", async () => {
    const r = await inspectJar(fabric({ depends: { minecraft: ["=26.1", "=26.3"] } }), "a.jar", T);
    expect(r.minecraftRange).toBe("=26.1 || =26.3");
    expect(r.problems).toEqual([]);
  });

  test("rejects a jar for another Minecraft version", async () => {
    const r = await inspectJar(fabric({ depends: { minecraft: "=26.1.2" } }), "world-bosses.jar", T);
    expect(r.problems).toEqual(["world-bosses.jar is built for Minecraft =26.1.2, but the profile is on 26.3."]);
  });

  test("rejects a jar that needs a newer Java", async () => {
    const r = await inspectJar(fabric({ depends: { java: ">=26" } }), "a.jar", T);
    expect(r.problems).toEqual(["a.jar needs Java >=26, but Minecraft 26.3 runs on Java 25."]);
  });

  test("names the loader of a NeoForge or Forge build", async () => {
    const neo = await inspectJar(jar({ "META-INF/neoforge.mods.toml": "" }), "collectall-neoforge.jar", T);
    expect(neo.problems).toEqual(["collectall-neoforge.jar is a NeoForge build. Get the Fabric build of this mod instead."]);
    const forge = await inspectJar(jar({ "META-INF/mods.toml": "" }), "BiomesOPlenty-forge.jar", T);
    expect(forge.problems[0]).toContain("is a Forge build");
    const other = await inspectJar(jar({ "readme.txt": "" }), "x.jar", T);
    expect(other.problems).toEqual(["x.jar isn't a Fabric mod (it has no fabric.mod.json)."]);
  });

  test("rejects an empty or truncated file", async () => {
    const r = await inspectJar(new Uint8Array(0), "ClickMobs.jar", T);
    expect(r.problems).toEqual(["ClickMobs.jar isn't a valid jar. Was the download finished?"]);
    const cut = await inspectJar(fabric().slice(0, 40), "cut.jar", T);
    expect(cut.problems[0]).toContain("isn't a valid jar");
  });

  test("rejects a bad fabric.mod.json and a bad file name", async () => {
    expect((await inspectJar(jar({ "fabric.mod.json": "{nope" }), "a.jar", T)).problems).toEqual([
      "a.jar has a fabric.mod.json that isn't valid JSON.",
    ]);
    expect((await inspectJar(fabric(), "a.zip", T)).problems).toEqual(['"a.zip" must be a file name ending in ".jar".']);
    expect((await inspectJar(fabric(), "../a.jar", T)).problems[0]).toContain("must be a file name");
  });

  test("accepts a name with spaces", async () => {
    expect((await inspectJar(fabric(), "antiquetradingship-1.0.0 Fabric 26.3.jar", T)).problems).toEqual([]);
  });

  // Final review: modules inside Fabric API aren't extra dependencies.
  test("leaves Fabric API modules out of depends", async () => {
    const deps = { "fabric-resource-loader-v0": "*", "fabric-api-base": "*", "fabric-language-kotlin": "*" };
    expect((await inspectJar(fabric({ depends: deps }), "a.jar", T)).depends).toEqual(["fabric-language-kotlin"]);
  });

  test("an unreadable range is not a problem", async () => {
    expect((await inspectJar(fabric({ depends: { minecraft: "@latest" } }), "a.jar", T)).problems).toEqual([]);
  });
});

describe("profile helpers", () => {
  test("jarName normalizes the mod ID, or falls back to the file name", () => {
    expect(jarName("dragonbond", "x.jar")).toBe("dragonbond");
    expect(jarName("Alex_Mobs", "x.jar")).toBe("alex_mobs");
    expect(jarName(null, "Strucutres v4.2.jar")).toBe("strucutres-v4.2");
  });

  test("jarProfileLine is one line of JSON in profile key order", () => {
    expect(jarProfileLine({ name: "dragonbond", filename: "a b.jar", sha512: "f".repeat(128), side: "both" })).toBe(
      `{"jar":"dragonbond","filename":"a b.jar","sha512":"${"f".repeat(128)}","side":"both"}`,
    );
  });

  test("dependencyHints skips what the profile already has", () => {
    expect(dependencyHints(["citadel", "collective"], ["collective"])).toEqual([
      'Needs "citadel". Add it from Modrinth if it\'s there, or upload its jar too.',
    ]);
  });

  test("dependencyHints names each dependency", () => {
    expect(dependencyHints(["citadel"])).toEqual([
      'Needs "citadel". Add it from Modrinth if it\'s there, or upload its jar too.',
    ]);
  });
});
