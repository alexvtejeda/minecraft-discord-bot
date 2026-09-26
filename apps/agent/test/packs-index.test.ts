import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { indexPack, mentions, provides } from "../src/packs/index";

const enc = (s: string) => new TextEncoder().encode(s);
const FILE = "player head drops v1.1.17 (MC 26.2).zip";

async function heads() {
  const dir = mkdtempSync(join(tmpdir(), "mc-packidx-"));
  writeFileSync(
    join(dir, FILE),
    zipSync(
      {
        "pack.mcmeta": enc('{"pack":{"min_format":101}}'),
        "data/minecraft/loot_table/entities/player.json": enc('{"value":"Player_Heads:entities/player"}'),
        "data/player_heads/loot_table/entities/player.json": enc('{"value":"graves:entities/player"}'),
        "data/player_heads/function/tick.mcfunction": enc("say hi"),
        "data/player_heads/structure/head.nbt": new Uint8Array([1, 2, 3]),
      },
      { level: 0 },
    ),
  );
  return { dir, pack: await indexPack(dir, FILE) };
}

test("indexes entry paths and the text of json, mcfunction and mcmeta files", async () => {
  const { pack } = await heads();
  expect(pack.file).toBe(FILE);
  expect(pack.paths).toEqual([
    "data/minecraft/loot_table/entities/player.json",
    "data/player_heads/function/tick.mcfunction",
    "data/player_heads/loot_table/entities/player.json",
    "data/player_heads/structure/head.nbt",
    "pack.mcmeta",
  ]);
  expect(pack.text).toContain("graves:entities/player");
  expect(pack.text).toContain("say hi");
  expect(pack.text).toBe(pack.text.toLowerCase());
});

test("provides: the id's namespace folder holds a file with that path, whatever the type folder", async () => {
  const { pack } = await heads();
  expect(provides(pack, "minecraft:entities/player")).toBe(true);
  expect(provides(pack, "player_heads:tick")).toBe(true);
  expect(provides(pack, "player_heads:head")).toBe(true);
  expect(provides(pack, "player_heads:entities/zombie")).toBe(false);
  expect(provides(pack, "graves:entities/player")).toBe(false);
});

test("mentions: any id in the text, case-insensitive, except minecraft ones", async () => {
  const { pack } = await heads();
  expect(mentions(pack, "graves:entities/player")).toBe(true);
  expect(mentions(pack, "player_heads:entities/player")).toBe(true);
  expect(mentions(pack, "minecraft:entities/player")).toBe(false);
  expect(mentions(pack, "more_mob_heads:entities/shulker")).toBe(false);
});

test("a file that isn't a zip is a plain error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-packidx-"));
  writeFileSync(join(dir, "broken.zip"), "not a zip");
  await expect(indexPack(dir, "broken.zip")).rejects.toThrow("broken.zip isn't a readable zip");
});
