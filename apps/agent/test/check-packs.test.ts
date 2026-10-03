import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPacks, formatReport, type BootResult, type CheckReport } from "../src/packs/check";
import type { PackIndex } from "../src/packs/index";

const log = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "packs", `${name}.log`), "utf8").split(/\r?\n/);
const pack = (file: string, text = ""): PackIndex => ({ file, paths: [], text: text.toLowerCase() });
const HEADS = pack("player head drops v1.1.17 (MC 26.2).zip", '{"value":"graves:entities/player"}');
const SHELLS = pack("double shulker shells v1.3.17 (MC 26.2).zip", '{"value":"more_mob_heads:entities/shulker"}');
const AFK = pack("afk display v1.1.17 (MC 26.2).zip", '{"type":"minecraft:loot_table"}');
const A = pack("a.zip");
const B = pack("b.zip");
const DONE = '[10:00:09] [Server thread/INFO]: Done (1.0s)! For help, type "help"';
const ok = (...lines: string[]): BootResult => ({ lines: [...lines, DONE], started: true });
const broke = (started: boolean): BootResult => ({ lines: ["[10:00:01] [main/ERROR]: Something broke"], started });

function scripted(answer: (files: string[]) => BootResult) {
  const calls: { files: string[]; label: string }[] = [];
  return {
    calls,
    boot: async (files: string[], label: string) => {
      calls.push({ files, label });
      return answer(files);
    },
  };
}

// Review focus 2
test("the Phase 1 failure: two packs blamed from the fatal boot, then the rest boot clean", async () => {
  const s = scripted((files) => {
    if (files.length === 0) return { lines: log("baseline"), started: true };
    if (files.includes(HEADS.file) || files.includes(SHELLS.file)) return { lines: log("fatal"), started: false };
    return { lines: log("clean"), started: true };
  });
  const r = await checkPacks([AFK, HEADS, SHELLS], s.boot, () => {});
  expect(s.calls).toEqual([
    { files: [], label: "baseline" },
    { files: [AFK.file, HEADS.file, SHELLS.file], label: "all" },
    { files: [AFK.file], label: "all" },
  ]);
  expect([...r.failed.keys()].sort()).toEqual([HEADS.file, SHELLS.file].sort());
  expect(r.failed.get(SHELLS.file)![0]).toContain("Unbound values in registry");
  expect(r).toMatchObject({ together: null, boots: 3, packs: [AFK.file, SHELLS.file, HEADS.file] });
});

test("errors the no-pack boot also has are ignored", async () => {
  const s = scripted(() => ok("[10:00:01] [main/ERROR]: Mod noise"));
  const r = await checkPacks([A, B], s.boot, () => {});
  expect(r.failed.size).toBe(0);
  expect(r.boots).toBe(2);
});

test("an error that names no pack: each pack is booted alone, and the one that fails alone is named", async () => {
  const s = scripted((files) => (files.includes(B.file) ? broke(false) : ok()));
  const r = await checkPacks([A, B], s.boot, () => {});
  expect(s.calls.map((c) => c.label)).toEqual(["baseline", "all", "alone-a", "alone-b", "all"]);
  expect([...r.failed]).toEqual([[B.file, ["Something broke"]]]);
  expect(r.together).toBeNull();
});

test("packs that only fail together are reported together", async () => {
  const s = scripted((files) => (files.length === 2 ? broke(true) : ok()));
  const r = await checkPacks([A, B], s.boot, () => {});
  expect(r.failed.size).toBe(0);
  expect(r.together).toEqual({ files: [A.file, B.file], lines: ["Something broke"] });
});

test("a boot that doesn't start and logs nothing new still fails its pack", async () => {
  const s = scripted((files) => (files.length ? { lines: [], started: false } : ok()));
  const r = await checkPacks([A], s.boot, () => {});
  expect([...r.failed]).toEqual([[A.file, ["The server didn't finish starting."]]]);
});

test("a server that doesn't start without packs stops the check", async () => {
  const s = scripted(() => broke(false));
  await expect(checkPacks([A], s.boot, () => {})).rejects.toThrow(
    "The server doesn't start even without datapacks, so the packs can't be checked. Fix that first.\nSomething broke",
  );
});

test("the report: ok and FAIL lines, at most 3 evidence lines cut to 300 characters", () => {
  const long = "x".repeat(400);
  const r: CheckReport = { packs: [A.file, B.file], failed: new Map([[B.file, ["one", "two", "three", long]]]), together: null, boots: 4 };
  const out = formatReport(r);
  expect(out.lines).toEqual(["  ok    a.zip", "  FAIL  b.zip", "        one", "        two", "        three"]);
  expect(out.summary).toBe("1 of 2 datapacks have errors (4 boots).");
  expect(out.ok).toBe(false);
  const cut = formatReport({ ...r, failed: new Map([[B.file, [long]]]) });
  expect(cut.lines[2]).toBe(`        ${"x".repeat(299)}…`);
});

test("the report for packs that only fail together, and for a clean run", () => {
  const together = formatReport({ packs: [A.file, B.file], failed: new Map(), together: { files: [A.file, B.file], lines: ["Something broke"] }, boots: 4 });
  expect(together.lines).toEqual(["  ok    a.zip", "  ok    b.zip", "These datapacks only fail together: a.zip, b.zip", "        Something broke"]);
  expect(together.summary).toBe("0 of 2 datapacks have errors on their own, but 2 fail together (4 boots).");
  expect(together.ok).toBe(false);
  expect(formatReport({ packs: [A.file], failed: new Map(), together: null, boots: 2 })).toEqual({
    lines: ["  ok    a.zip"],
    summary: "The datapack loaded without errors (2 boots).",
    ok: true,
  });
  expect(formatReport({ packs: [A.file, B.file], failed: new Map(), together: null, boots: 2 }).summary).toBe(
    "All 2 datapacks loaded without errors (2 boots).",
  );
});

test("a mod problem at the baseline boot is reported by name", async () => {
  const s = scripted(() => ({
    lines: [
      "[12:00:01] [main/ERROR]: Incompatible mods found!",
      "\t - Install citadel, version 26.3-1.0.0 or later.",
    ],
    started: false,
  }));
  await expect(checkPacks([], s.boot, () => {})).rejects.toThrow("The server doesn't start because of its mods:\n  - Install citadel, version 26.3-1.0.0 or later.");
});

test("no packs: one boot, and a mods summary", async () => {
  const s = scripted(() => ok());
  const r = await checkPacks([], s.boot, () => {});
  expect(s.calls).toHaveLength(1);
  expect(formatReport(r).summary).toBe("The mods loaded without errors (1 boots).");
});

// Final review: a mods-only boot that starts but logs errors isn't clean.
test("no packs: errors the mods log are reported even when the server starts", async () => {
  const s = scripted(() => ok("[10:00:01] [main/ERROR]: Mixin apply failed for dragonbond"));
  const f = formatReport(await checkPacks([], s.boot, () => {}));
  expect(f.ok).toBe(false);
  expect(f.summary).toBe("The server started, but the mods logged errors (1 boots).");
  expect(f.lines.join("\n")).toContain("Mixin apply failed for dragonbond");
});
