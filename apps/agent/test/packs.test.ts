import { expect, test } from "bun:test";
import { matchPacks, packNameFromFilename } from "../src/server/packs";

// Review focus 5: real Vanilla Tweaks names
test("normalizes Vanilla Tweaks file names", () => {
  expect(packNameFromFilename("afk display v1.1.17 (MC 26.2).zip")).toBe("afk-display");
  expect(packNameFromFilename("more mob heads v2.20.0 (MC 26.2).zip")).toBe("more-mob-heads");
  expect(packNameFromFilename("track raw statistics v1.7.13 (MC 26.2).zip")).toBe("track-raw-statistics");
  expect(packNameFromFilename("MyPack.zip")).toBe("mypack");
  expect(packNameFromFilename("readme.txt")).toBeNull();
});

test("matches ids to files and lists missing ones", () => {
  const { found, missing } = matchPacks(
    ["vt:afk-display", "vt:wood-stripper", "vt:ghost"],
    ["afk display v1.1.17 (MC 26.2).zip", "wood stripper v1.0.1 (MC 26.2).zip", "notes.txt"],
  );
  expect([...found]).toEqual([
    ["vt:afk-display", "afk display v1.1.17 (MC 26.2).zip"],
    ["vt:wood-stripper", "wood stripper v1.0.1 (MC 26.2).zip"],
  ]);
  expect(missing).toEqual(["vt:ghost"]);
});
