import type { APIInteraction } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmRow, parseConfirmId } from "../src/discord/confirm";
import type { Registry } from "../src/discord/registry";
import { fit, reply, update } from "../src/discord/respond";
import { handleInteraction } from "../src/discord/router";
import { help } from "../src/commands/help";
import { ApiError } from "../src/errors";
import { ALEX, autocomplete, button, requestMeta, slash } from "./discord";

afterEach(() => vi.restoreAllMocks());

const seen: unknown[] = [];
const fake: Registry = {
  groups: { world: "World things" },
  commands: [
    help,
    { path: "echo", description: "Echo", maintainerOnly: false, run: async (c) => reply(`echo ${c.options.text} from ${c.userId}`) },
    {
      path: "world ping",
      description: "Ping a world",
      maintainerOnly: false,
      run: async (c) => reply(`pong ${c.options.n}`),
      autocomplete: async (c, focused) => [{ name: `${focused}=${c.options[focused]}`, value: 1 }],
    },
    {
      path: "world wipe",
      description: "Wipe it",
      maintainerOnly: true,
      run: async () => reply("wiping?", confirmRow("wipe", ["w1", "7"], "Wipe")),
      autocomplete: async () => [{ name: "secret", value: 1 }],
    },
    { path: "boom", description: "Fails", maintainerOnly: false, run: async () => { throw new ApiError("conflict", "Plain-English problem."); } },
    { path: "crash", description: "Crashes", maintainerOnly: false, run: async () => { throw new Error("db exploded"); } },
  ],
  actions: [{ name: "wipe", run: async (_c, args) => { seen.push(args); return update(`wiped ${args.join(",")}`); } }],
};

const run = (payload: unknown) => handleInteraction(payload as APIInteraction, requestMeta(), fake);

describe("slash commands", () => {
  it("runs a command with its options and the caller", async () => {
    const r: any = await run(slash("echo", { text: "hi" }));
    expect(r).toMatchObject({ type: 4, data: { content: `echo hi from ${ALEX}`, flags: 64, allowed_mentions: { parse: [] } } });
  });

  it("flattens a subcommand's path and options", async () => {
    expect(((await run(slash("world ping", { n: 3 }))) as any).data.content).toBe("pong 3");
  });

  it("refuses a maintainer command without the role, and runs it with the role", async () => {
    expect(((await run(slash("world wipe"))) as any).data.content).toBe("That needs the MC Maintainer role.");
    expect(((await run(slash("world wipe", {}, { maintainer: true }))) as any).data.content).toBe("wiping?");
  });

  it("treats an interaction without a member as not a maintainer", async () => {
    expect(((await run(slash("world wipe", {}, { noMember: true, maintainer: true }))) as any).data.content).toBe(
      "That needs the MC Maintainer role.",
    );
  });

  it("answers an unknown command in plain English", async () => {
    expect(((await run(slash("nope"))) as any).data.content).toMatch(/I don't know that command/);
  });

  it("shows an ApiError's message, and a generic one for anything else", async () => {
    expect(((await run(slash("boom"))) as any).data.content).toBe("Plain-English problem.");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(((await run(slash("crash"))) as any).data).toMatchObject({
      content: "Something went wrong on my end, try again in a minute.",
      flags: 64,
    });
    expect(log).toHaveBeenCalled();
  });
});

describe("autocomplete", () => {
  it("passes the focused option", async () => {
    expect(await run(autocomplete("world ping", { n: "4" }, "n"))).toEqual({ type: 8, data: { choices: [{ name: "n=4", value: 1 }] } });
  });

  it("gives non-maintainers nothing for a maintainer command", async () => {
    expect(await run(autocomplete("world wipe", { n: "" }, "n"))).toEqual({ type: 8, data: { choices: [] } });
  });
});

describe("buttons", () => {
  it("Cancel replaces the preview and removes the buttons", async () => {
    expect(await run(button("x", { maintainer: true }))).toEqual({
      type: 7,
      data: { content: "Cancelled. Nothing changed.", components: [], allowed_mentions: { parse: [] } },
    });
  });

  it("Confirm runs the action with its args", async () => {
    seen.length = 0;
    const r: any = await run(button("c:wipe:w1:7", { maintainer: true }));
    expect(r).toMatchObject({ type: 7, data: { content: "wiped w1,7", components: [] } });
    expect(seen).toEqual([["w1", "7"]]);
  });

  it("Confirm re-checks the role, leaving the preview alone", async () => {
    seen.length = 0;
    const r: any = await run(button("c:wipe:w1:7"));
    expect(r).toMatchObject({ type: 4, data: { content: "That needs the MC Maintainer role.", flags: 64 } });
    expect(seen).toEqual([]);
  });

  it("an unknown action says so", async () => {
    expect(((await run(button("c:gone:1", { maintainer: true }))) as any).data.content).toMatch(/doesn't do anything any more/);
  });
});

describe("helpers", () => {
  it("fit cuts long content at a line break, under 2000 characters", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const out = fit(long);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.endsWith("…(cut to fit Discord's limit)")).toBe(true);
    expect(fit("short")).toBe("short");
  });

  it("confirm ids round-trip and refuse to pass 100 characters", () => {
    const row = confirmRow("new", ["abc", "name", "seed:with:colons"], "Go");
    const id = (row[0]!.components[0] as { custom_id: string }).custom_id;
    expect(parseConfirmId(id)).toEqual({ action: "new", args: ["abc", "name", "seed", "with", "colons"] });
    expect(parseConfirmId("x")).toBeNull();
    expect(() => confirmRow("new", ["a".repeat(100)], "Go")).toThrow(/too long/);
  });
});

describe("/help", () => {
  it("lists everyone's commands, and maintainer ones only for maintainers", async () => {
    const plain = ((await run(slash("help"))) as any).data.content as string;
    expect(plain).toContain("`/echo`");
    expect(plain).toContain("`/world ping`");
    expect(plain).not.toContain("`/world wipe`");
    const maint = ((await run(slash("help", {}, { maintainer: true }))) as any).data.content as string;
    expect(maint).toContain("`/world wipe`");
  });
});
