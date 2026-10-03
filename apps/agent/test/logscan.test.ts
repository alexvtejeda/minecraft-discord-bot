import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackIndex } from "../src/packs/index";
import { attribute, errorKey, fabricModProblems, packFileMentions, resourceIds, scanLog } from "../src/packs/logscan";

const log = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "packs", `${name}.log`), "utf8").split(/\r?\n/);
const firstLines = (name: string) => scanLog(log(name)).map((e) => e.lines[0]);
const pack = (file: string, text = "", paths: string[] = []): PackIndex => ({ file, paths, text: text.toLowerCase() });

const UNBOUND =
  "java.lang.IllegalStateException: Unbound values in registry ResourceKey[minecraft:root / minecraft:loot_table]: [graves:entities/player, more_mob_heads:entities/shulker]";
const HEADS = pack("player head drops v1.1.17 (MC 26.2).zip", '{"value":"graves:entities/player"}');
const SHELLS = pack("double shulker shells v1.3.17 (MC 26.2).zip", '{"value":"more_mob_heads:entities/shulker"}');
const AFK = pack("afk display v1.1.17 (MC 26.2).zip", '{"type":"minecraft:loot_table"}');

test("the no-pack boot has the two errors the mods always log", () => {
  expect(firstLines("baseline")).toEqual([
    "No key layers in MapLike[{}]",
    "Failed to load function nova_structures:structure_search/dnt/underground",
  ]);
});

test("the fatal boot keeps the registry block without stack frames, and drops the 'can't proceed' line", () => {
  const errors = scanLog(log("fatal"));
  expect(errors.map((e) => e.lines[0])).toEqual(["No key layers in MapLike[{}]", "Registry loading errors:"]);
  expect(errors[1]!.lines).toEqual([
    "Registry loading errors:",
    "> Errors in registry minecraft:root:",
    ">> Errors in element minecraft:loot_table:",
    UNBOUND,
  ]);
});

test("the clean boot has only the baseline's errors, even with other timestamps and threads", () => {
  const known = new Set(scanLog(log("baseline")).map(errorKey));
  expect(scanLog(log("clean")).filter((e) => !known.has(errorKey(e)))).toEqual([]);
});

// Review focus 1
test("errorKey ignores numbers, so timings don't get past the baseline", () => {
  const a = scanLog(["[10:00:00] [main/ERROR]: Took 12 ms to load 3 things"]);
  const b = scanLog(["[11:22:33] [Worker-Main-9/ERROR]: Took 480 ms to load 3 things"]);
  expect(errorKey(a[0]!)).toBe(errorKey(b[0]!));
});

test("only data-related WARN lines count", () => {
  const errors = scanLog([
    "[10:00:00] [main/WARN]: Reference map 'x.refmap.json' for x.mixins.json could not be read.",
    "[10:00:00] [main/WARN]: Pack file/old.zip is incompatible with this version",
    "[10:00:00] [main/INFO]: Found new data pack file/old.zip, loading it automatically",
  ]);
  expect(errors.map((e) => e.lines[0])).toEqual(["Pack file/old.zip is incompatible with this version"]);
});

test("resource ids and pack files are pulled out of a line", () => {
  expect(resourceIds(UNBOUND)).toEqual(["minecraft:root", "minecraft:loot_table", "graves:entities/player", "more_mob_heads:entities/shulker"]);
  expect(packFileMentions("Found new data pack file/afk display v1.1.17 (MC 26.2).zip, loading it automatically")).toEqual([
    "afk display v1.1.17 (MC 26.2).zip",
  ]);
});

// Review focus 2
test("the Phase 1 failure blames exactly the two packs that mention the unbound loot tables", () => {
  const known = new Set(scanLog(log("baseline")).map(errorKey));
  const errors = scanLog(log("fatal")).filter((e) => !known.has(errorKey(e)));
  const { blamed, unattributed } = attribute(errors, [AFK, HEADS, SHELLS]);
  expect([...blamed.keys()].sort()).toEqual([SHELLS.file, HEADS.file].sort());
  expect(blamed.get(HEADS.file)).toEqual([UNBOUND]);
  expect(unattributed).toEqual([]);
});

test("a line naming a pack's file, or an id the pack provides, blames it too", () => {
  const vt = pack("more effective tools v1.0.11 (MC 26.2).zip", "", ["data/vt/recipe/axe.json"]);
  const byFile = scanLog(["[10:00:00] [main/WARN]: Pack file/more effective tools v1.0.11 (MC 26.2).zip is incompatible"]);
  const byId = scanLog(["[10:00:00] [Worker-Main-1/ERROR]: Couldn't parse element vt:axe"]);
  expect([...attribute(byFile, [vt, AFK]).blamed.keys()]).toEqual([vt.file]);
  expect([...attribute(byId, [vt, AFK]).blamed.keys()]).toEqual([vt.file]);
});

test("an error no pack can be tied to is unattributed", () => {
  const errors = scanLog(["[10:00:00] [main/ERROR]: Something broke"]);
  expect(attribute(errors, [AFK, HEADS])).toEqual({ blamed: new Map(), unattributed: errors });
});

// Final review 2
test("errorKey ignores object hashes and uuids that change between boots", () => {
  const a = scanLog(["[10:00:00] [main/ERROR]: Bad codec for net.minecraft.class_2960@6d3af739 in 3f2a1b4c-0d9e-4f11-8a2b-7c6d5e4f3a21"]);
  const b = scanLog(["[10:00:00] [main/ERROR]: Bad codec for net.minecraft.class_2960@1b2c3d4e in 9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b"]);
  expect(errorKey(a[0]!)).toBe(errorKey(b[0]!));
});

const FABRIC_FAIL = [
  "[12:00:00] [main/INFO]: Loading 52 mods",
  "[12:00:01] [main/ERROR]: Incompatible mods found!",
  "net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
  "A potential solution has been determined, this may resolve your problem:",
  "\t - Install citadel, version 26.3-1.0.0 or later.",
  "More details:",
  "\t - Mod 'Alex's Mobs' (alexsmobs) 1.0.0 requires version 26.3-1.0.0 or later of mod 'citadel', which is missing!",
  "\tat net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:51)",
  "\t - not part of the report",
];

test("fabricModProblems lists the report's items once each", () => {
  expect(fabricModProblems(FABRIC_FAIL)).toEqual([
    "Install citadel, version 26.3-1.0.0 or later.",
    "Mod 'Alex's Mobs' (alexsmobs) 1.0.0 requires version 26.3-1.0.0 or later of mod 'citadel', which is missing!",
  ]);
  expect(fabricModProblems(["[12:00:00] [main/INFO]: Done"])).toEqual([]);
});
