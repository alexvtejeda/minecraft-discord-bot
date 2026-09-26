import { expect, test } from "bun:test";
import { parseCommand } from "../src/cli";

test("parses each profile subcommand", () => {
  expect(parseCommand(["profile", "resolve", "adventure"])).toEqual({ kind: "resolve", name: "adventure", check: undefined, addReady: false, profilesDir: "profiles" });
  expect(parseCommand(["profile", "resolve", "adventure", "--check", "26.4", "--add-ready"])).toMatchObject({ check: "26.4", addReady: true });
  expect(parseCommand(["profile", "build-server", "adventure", "srv", "--packs", "vt"])).toEqual({
    kind: "build-server", name: "adventure", dir: "srv", packsDir: "vt", profilesDir: "profiles", force: false,
  });
  expect(parseCommand(["profile", "build-server", "a", "srv", "--force"])).toMatchObject({ force: true });
  expect(parseCommand(["profile", "build-mrpack", "adventure", "out.mrpack", "--profiles", "p"])).toEqual({
    kind: "build-mrpack", name: "adventure", out: "out.mrpack", profilesDir: "p",
  });
  expect(parseCommand(["profile", "run", "srv"])).toEqual({ kind: "run", dir: "srv" });
});

test("help for no args or --help", () => {
  expect(parseCommand([])).toEqual({ kind: "help" });
  expect(parseCommand(["--help"])).toEqual({ kind: "help" });
});

test("plain-English errors for missing args, unknown commands and flags", () => {
  expect(() => parseCommand(["profile", "build-server", "adventure"])).toThrow(/Missing <dir>/);
  expect(() => parseCommand(["profile", "frobnicate"])).toThrow(/Unknown command "profile frobnicate"/);
  expect(() => parseCommand(["profile", "resolve", "x", "--nope"])).toThrow(/Unknown option/);
});
