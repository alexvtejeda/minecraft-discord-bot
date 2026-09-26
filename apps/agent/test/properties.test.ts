import { expect, test } from "bun:test";
import { mergeProperties } from "../src/server/properties";

test("replaces existing keys in place, keeps comments and other keys", () => {
  const existing = "#Minecraft server properties\ndifficulty=easy\nlevel-seed=123\n";
  expect(mergeProperties(existing, { difficulty: "hard" })).toBe(
    "#Minecraft server properties\ndifficulty=hard\nlevel-seed=123\n",
  );
});

test("appends new keys sorted", () => {
  expect(mergeProperties("", { "view-distance": 10, difficulty: "normal", pvp: true })).toBe(
    "difficulty=normal\npvp=true\nview-distance=10\n",
  );
});

test("handles CRLF files", () => {
  expect(mergeProperties("a=1\r\nb=2\r\n", { b: 3 })).toBe("a=1\nb=3\n");
});
