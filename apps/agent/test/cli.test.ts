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
  expect(parseCommand(["profile", "check-packs", "adventure", "--packs", "datapacks"])).toEqual({
    kind: "check-packs", name: "adventure", packsDir: "datapacks", all: false, keep: false, profilesDir: "profiles",
  });
  expect(parseCommand(["profile", "check-packs", "a", "--packs", "d", "--all", "--keep"])).toMatchObject({ all: true, keep: true });
});

test("help for no args or --help", () => {
  expect(parseCommand([])).toEqual({ kind: "help" });
  expect(parseCommand(["--help"])).toEqual({ kind: "help" });
});

test("--version and version print the version", () => {
  expect(parseCommand(["--version"])).toEqual({ kind: "version" });
  expect(parseCommand(["version"])).toEqual({ kind: "version" });
});

test("plain-English errors for missing args, unknown commands and flags", () => {
  expect(() => parseCommand(["profile", "build-server", "adventure"])).toThrow(/Missing <dir>/);
  expect(() => parseCommand(["profile", "frobnicate"])).toThrow(/Unknown command "profile frobnicate"/);
  expect(() => parseCommand(["profile", "resolve", "x", "--nope"])).toThrow(/Unknown option/);
  expect(() => parseCommand(["profile", "check-packs", "adventure"])).toThrow(/Missing --packs <folder>/);
});

test("parses the hosting and admin commands", () => {
  expect(parseCommand(["start"])).toEqual({ kind: "start" });
  expect(parseCommand(["stop"])).toEqual({ kind: "stop" });
  expect(parseCommand(["status"])).toEqual({ kind: "status" });
  expect(parseCommand(["admin", "world", "create", "adventure", "--import", "srv", "--replace", "--name", "adv-1"])).toEqual({
    kind: "admin-world-create",
    profile: "adventure",
    name: "adv-1",
    replace: true,
    importDir: "srv",
    profilesDir: "profiles",
  });
  expect(parseCommand(["admin", "world", "create", "adventure"])).toMatchObject({ replace: false, name: undefined, importDir: undefined });
  expect(parseCommand(["admin", "token", "mint", "123456789012345678", "Sam"])).toEqual({
    kind: "admin-token-mint",
    discordId: "123456789012345678",
    name: "Sam",
  });
  expect(parseCommand(["admin", "lease", "release"])).toEqual({ kind: "admin-lease-release" });
  expect(parseCommand(["admin", "status"])).toEqual({ kind: "admin-status" });
});

test("plain-English errors for admin and unknown commands", () => {
  expect(() => parseCommand(["admin", "token", "mint", "123"])).toThrow(/Missing <name>/);
  expect(() => parseCommand(["admin", "world", "delete"])).toThrow(/Unknown command "admin world delete"/);
  expect(() => parseCommand(["host"])).toThrow(/Unknown command "host"/);
});

test("admin jar add", () => {
  expect(parseCommand(["admin", "jar", "add", "cst", "mods/a b.jar"])).toEqual({
    kind: "admin-jar-add", profile: "cst", file: "mods/a b.jar", side: "both", name: undefined, profilesDir: "profiles",
  });
  expect(parseCommand(["admin", "jar", "add", "cst", "x.jar", "--side", "server", "--name", "x"])).toMatchObject({ side: "server", name: "x" });
  expect(() => parseCommand(["admin", "jar", "add", "cst"])).toThrow(/Missing <file.jar>/);
});
