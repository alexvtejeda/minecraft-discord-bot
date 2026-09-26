import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/commands";
import { toDiscordCommands } from "../src/discord/definitions";

const NAME = /^[a-z0-9-]{1,32}$/;

describe("toDiscordCommands", () => {
  const cmds = toDiscordCommands(REGISTRY);
  const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));

  it("registers each top-level command and group once", () => {
    expect(cmds.map((c) => c.name).sort()).toEqual(["help", "host", "join", "mod", "modpack", "setup", "status", "tailnet", "world"]);
  });

  it("keeps names and descriptions inside Discord's limits", () => {
    const check = (name: string, description: string) => {
      expect(name).toMatch(NAME);
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(100);
    };
    type Opt = { name: string; description: string; options?: Opt[] };
    for (const c of cmds) {
      check(c.name, c.description);
      for (const o of (c.options ?? []) as Opt[]) {
        check(o.name, o.description);
        for (const sub of o.options ?? []) check(sub.name, sub.description);
      }
    }
  });

  it("hides a command only when every part of it is maintainer-only", () => {
    expect(byName.host!.default_member_permissions).toBe("0");
    expect(byName.tailnet!.default_member_permissions).toBe("0");
    expect(byName.world!.default_member_permissions).toBeUndefined(); // /world download is for everyone
    expect(byName.status!.default_member_permissions).toBeUndefined();
  });

  it("/setup is play, host and help, open to everyone", () => {
    expect(byName.setup!.options!.map((o) => o.name)).toEqual(["play", "host", "help"]);
    expect(byName.setup!.default_member_permissions).toBeUndefined();
  });

  it("puts subcommands under their group", () => {
    expect(byName.world!.options!.map((o) => o.name)).toEqual(["download", "new", "rollback", "archive", "repin"]);
    expect(byName.world!.options!.every((o) => o.type === 1)).toBe(true);
  });
});
