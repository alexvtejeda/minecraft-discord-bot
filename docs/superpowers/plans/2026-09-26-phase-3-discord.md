# Phase 3: Discord commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The existing Worker answers Discord slash commands (`/help`, `/status`, `/join`, `/modpack`, `/world …`, `/mod list`, `/host release`) and posts an announcement when a server starts or stops.

**Architecture:** `POST /interactions` verifies Discord's Ed25519 signature with WebCrypto and hands the payload to `handleInteraction`. It dispatches through one `Registry` of commands and Confirm actions. The same registry is serialized by `register-commands.ts`. Handlers call the existing `lease.ts`, `worlds.ts` and `snapshots.ts` directly. Destructive commands reply with an ephemeral preview and Confirm/Cancel buttons whose `custom_id` carries the action, so nothing is stored. Announcements are posted with the bot token from `ctx.waitUntil` in the agent routes.

**Tech Stack:** Cloudflare Workers, Hono 4, D1, R2, `discord-api-types` (v10), Vitest 4 with `@cloudflare/vitest-plugin` (Miniflare), fflate, Bun for the registration script.

**Spec:** [docs/superpowers/specs/2026-09-26-phase-3-discord-design.md](../specs/2026-09-26-phase-3-discord-design.md)

## Global Constraints

- Discord API base: `https://discord.com/api/v10`. Bot auth header: `Authorization: Bot <DISCORD_BOT_TOKEN>`.
- Signature: Ed25519 over `X-Signature-Timestamp + rawBody`, checked against `DISCORD_PUBLIC_KEY` (hex). A bad or missing signature gets `401` with the text `Bad request signature.`
- Every command reply is ephemeral (`flags: 64`) with `allowed_mentions: { parse: [] }`. Announcements set `allowed_mentions: { users: [<host id>] }` only.
- Message content is at most 2000 characters (`fit()`). Autocomplete choice names are at most 100 characters, with at most 25 choices. `custom_id` is at most 100 characters (`confirmRow` throws if it's longer).
- `custom_id` format: `c:<action>:<arg>:<arg>…` for Confirm, `x` for Cancel.
- Maintainer = `member.roles` includes `MAINTAINER_ROLE_ID`. Checked for maintainer commands, their autocomplete, and every Confirm click.
- Non-maintainer message, exactly: `That needs the MC Maintainer role.`
- Stale confirm message, exactly: `Things changed since the preview. Run the command again.`
- Unexpected error message, exactly: `Something went wrong on my end, try again in a minute.`
- Game port in addresses: `25565`, shown as `` `<ip>:25565` ``.
- An empty `ANNOUNCE_CHANNEL_ID` means "don't announce". Tests default to empty, so no test reaches the network by accident.
- A world seed is stored as `profile.properties["level-seed"]` in the world's `profile_json`, and `/world repin` carries it over.
- World names: `WorldNameSchema` from `@mc/protocol`, and at most 30 characters in the Discord option (the `custom_id` budget). Seeds: at most 32 characters.
- Tests live in `apps/worker/test/*.vitest.ts`. Run them with `bun run --cwd apps/worker test` (or `bunx vitest run <file>` from `apps/worker`).
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
  ```

## Review Focus

1. **Discord's size limits.** A profile with many mods must not make `/mod list` fail with a 400 from Discord. Rollback autocomplete names must stay ≤ 100 characters. Task 2 tests `fit()`, Task 5 tests an 80-mod `/mod list`, and Task 7 caps choice names.
2. **The `custom_id` budget.** A 30-character world name plus a 32-character seed containing `:` must still fit and round-trip. Task 6 tests it.
3. **State changing between preview and Confirm** (someone starts hosting, a world is archived, a save lands) must refuse with the stale message and change nothing. Tasks 6, 7 and 8 each test one.
4. **Discord being down or unconfigured** must never fail or slow an agent request. Task 3 tests a throwing fetch and an empty channel ID.
5. **A profile edited without re-running `profile resolve`** must be caught before deploy, not when someone runs `/world new`. Task 6 validates every bundled pair in a test.

---

## File Structure

```
apps/worker/src/
  env.ts                    MODIFY  Discord vars and the bot token
  index.ts                  MODIFY  mount /interactions and /modpack
  discord/
    verify.ts               NEW  verifyDiscordRequest
    respond.ts              NEW  reply, update, choices, fit, message constants
    confirm.ts              NEW  confirmRow, parseConfirmId, CANCEL_ID
    registry.ts             NEW  Command, ConfirmAction, Registry, Invocation types
    router.ts               NEW  handleInteraction
    definitions.ts          NEW  toDiscordCommands (registration JSON)
    rest.ts                 NEW  postMessage
    format.ts               NEW  duration, ago, mention, savedBy, size
  announce.ts               NEW  announceStarted, announceStopped, announceReleased
  mrpack.ts                 NEW  modpackUrl, worldMrpack
  profiles.ts               NEW  bundled profiles and lockfiles
  commands/
    index.ts                NEW  REGISTRY
    common.ts               NEW  NO_WORLD, hostingNow
    help.ts status.ts join.ts modpack.ts mod-list.ts
    world-download.ts world-new.ts world-rollback.ts world-archive.ts world-repin.ts host-release.ts
  routes/interactions.ts    NEW  POST /interactions
  routes/modpack.ts         NEW  GET /modpack/:file
  routes/agent.ts           MODIFY  announce on claim and release
  worlds.ts                 MODIFY  pruneWorld keeps shared objects; archiveWorld; repinWorld
  snapshots.ts              MODIFY  rollbackTo
apps/worker/scripts/register-commands.ts   NEW
apps/worker/test/discord.ts                NEW  signing, payload builders, fetch capture
apps/worker/test/helpers.ts                MODIFY  execution context in call(); lock entries; env fields
docs/setup/phase-3.md                      NEW
```

---

### Task 1: Discord config, signature check, and PING

**Files:**
- Modify: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/wrangler.jsonc`, `apps/worker/vitest.config.ts`, `apps/worker/src/env.ts`, `apps/worker/src/index.ts`, `apps/worker/test/env.d.ts`, `apps/worker/test/helpers.ts`
- Create: `apps/worker/src/discord/verify.ts`, `apps/worker/src/routes/interactions.ts`, `apps/worker/test/discord.ts`
- Test: `apps/worker/test/interactions.vitest.ts`

**Interfaces:**
- Produces: `verifyDiscordRequest(publicKeyHex: string, signatureHex: string | undefined, timestamp: string | undefined, body: string): Promise<boolean>`; `postInteraction(payload, o?)` test helper returning `{ status: number; body: any }`; `Env` fields `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_GUILD_ID`, `ANNOUNCE_CHANNEL_ID`, `MAINTAINER_ROLE_ID`, `DISCORD_BOT_TOKEN` (all `string`).

- [ ] **Step 1: Dependencies and config**

```bash
cd apps/worker && bun add discord-api-types && bun add -d fflate
```

In `apps/worker/tsconfig.json`, add `"resolveJsonModule": true` to `compilerOptions`.

In `apps/worker/wrangler.jsonc`, extend `vars` (the setup guide in Task 9 has the maintainer fill these in):
```jsonc
	"vars": {
		"R2_ACCOUNT_ID": "663d004e8e50dcaa58dddbd1403d8f3f",
		"R2_BUCKET_NAME": "mc-bot",
		"DISCORD_APP_ID": "",
		"DISCORD_PUBLIC_KEY": "",
		"DISCORD_GUILD_ID": "",
		"ANNOUNCE_CHANNEL_ID": "",
		"MAINTAINER_ROLE_ID": ""
	}
```

In `apps/worker/src/env.ts`, add to `Env`:
```ts
  DISCORD_APP_ID: string;
  /** Hex Ed25519 public key from the developer portal. */
  DISCORD_PUBLIC_KEY: string;
  DISCORD_GUILD_ID: string;
  /** Empty means announcements are off. */
  ANNOUNCE_CHANNEL_ID: string;
  MAINTAINER_ROLE_ID: string;
  DISCORD_BOT_TOKEN: string;
```

In `apps/worker/vitest.config.ts`, generate a test signing key at config time and pass it in:
```ts
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
// …existing imports…

// A throwaway Ed25519 key: tests sign interactions with the private half.
const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
```
and add to `miniflare.bindings`:
```ts
            TEST_DISCORD_JWK: JSON.stringify(jwk),
            DISCORD_PUBLIC_KEY: Buffer.from(jwk.x!, "base64url").toString("hex"),
            DISCORD_APP_ID: "200000000000000001",
            DISCORD_GUILD_ID: "300000000000000001",
            ANNOUNCE_CHANNEL_ID: "",
            MAINTAINER_ROLE_ID: "500000000000000001",
            DISCORD_BOT_TOKEN: "test-bot-token",
```

In `apps/worker/test/env.d.ts`, add `TEST_DISCORD_JWK: string;` inside `Cloudflare.Env`.

In `apps/worker/test/helpers.ts`, add the six new fields to `envWith`:
```ts
    DISCORD_APP_ID: env.DISCORD_APP_ID,
    DISCORD_PUBLIC_KEY: env.DISCORD_PUBLIC_KEY,
    DISCORD_GUILD_ID: env.DISCORD_GUILD_ID,
    ANNOUNCE_CHANNEL_ID: env.ANNOUNCE_CHANNEL_ID,
    MAINTAINER_ROLE_ID: env.MAINTAINER_ROLE_ID,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
```

- [ ] **Step 2: The signing test helper**

Create `apps/worker/test/discord.ts`:
```ts
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { app } from "../src/index";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sign(message: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.TEST_DISCORD_JWK), { name: "Ed25519" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message))));
}

/**
 * POST a signed interaction to /interactions and wait for its waitUntil work.
 * `signTimestamp` signs a different timestamp from the one sent; `tamper` edits the body after signing.
 */
export async function postInteraction(
  payload: unknown,
  o: { signature?: string; timestamp?: string; signTimestamp?: string; tamper?: (body: string) => string; env?: Env } = {},
): Promise<{ status: number; body: any }> {
  const body = JSON.stringify(payload);
  const timestamp = o.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = o.signature ?? (await sign((o.signTimestamp ?? timestamp) + body));
  const ctx = createExecutionContext();
  const res = await app.request(
    "/interactions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
      body: o.tamper ? o.tamper(body) : body,
    },
    o.env ?? env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}
```

- [ ] **Step 3: Write the failing tests**

Create `apps/worker/test/interactions.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { verifyDiscordRequest } from "../src/discord/verify";
import { postInteraction } from "./discord";

describe("POST /interactions", () => {
  it("answers PING with PONG", async () => {
    expect(await postInteraction({ type: 1 })).toEqual({ status: 200, body: { type: 1 } });
  });

  it("rejects a body changed after signing", async () => {
    const r = await postInteraction({ type: 1 }, { tamper: (b) => b.replace("1", "2") });
    expect(r).toEqual({ status: 401, body: "Bad request signature." });
  });

  it("rejects a timestamp that wasn't the one signed", async () => {
    const r = await postInteraction({ type: 1 }, { timestamp: "1700000001", signTimestamp: "1700000000" });
    expect(r.status).toBe(401);
  });

  it("rejects a missing or malformed signature", async () => {
    expect((await postInteraction({ type: 1 }, { signature: "" })).status).toBe(401);
    expect((await postInteraction({ type: 1 }, { signature: "zz" })).status).toBe(401);
    expect((await postInteraction({ type: 1 }, { signature: "ab".repeat(64) })).status).toBe(401);
  });
});

describe("verifyDiscordRequest", () => {
  it("is false for a public key that isn't 32 bytes of hex", async () => {
    expect(await verifyDiscordRequest("abcd", "ab".repeat(64), "1", "{}")).toBe(false);
    expect(await verifyDiscordRequest("", "ab".repeat(64), "1", "{}")).toBe(false);
  });

  it("is false without a timestamp", async () => {
    expect(await verifyDiscordRequest(env.DISCORD_PUBLIC_KEY, "ab".repeat(64), undefined, "{}")).toBe(false);
  });
});
```

- [ ] **Step 4: Run them to make sure they fail**

Run: `cd apps/worker && bunx vitest run test/interactions.vitest.ts`
Expected: FAIL, because `../src/discord/verify` can't be resolved.

- [ ] **Step 5: Implement**

Create `apps/worker/src/discord/verify.ts`:
```ts
function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (h) => Number.parseInt(h, 16));
}

/** Discord signs `timestamp + raw body` with the application's Ed25519 key. */
export async function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string | undefined,
  timestamp: string | undefined,
  body: string,
): Promise<boolean> {
  const key = hexToBytes(publicKeyHex);
  const sig = signatureHex ? hexToBytes(signatureHex) : null;
  if (!key || key.length !== 32 || !sig || sig.length !== 64 || !timestamp) return false;
  try {
    const pub = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", pub, sig, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}
```

Create `apps/worker/src/routes/interactions.ts`:
```ts
import { Hono } from "hono";
import { verifyDiscordRequest } from "../discord/verify";
import type { AppEnv } from "../env";

export const interactions = new Hono<AppEnv>();

interactions.post("/", async (c) => {
  const body = await c.req.text();
  const ok = await verifyDiscordRequest(
    c.env.DISCORD_PUBLIC_KEY,
    c.req.header("X-Signature-Ed25519"),
    c.req.header("X-Signature-Timestamp"),
    body,
  );
  if (!ok) return c.text("Bad request signature.", 401);
  const interaction = JSON.parse(body) as { type: number };
  if (interaction.type === 1) return c.json({ type: 1 });
  return c.json({ error: "unsupported" }, 400);
});
```

In `apps/worker/src/index.ts`, import it and mount it next to the other routers:
```ts
import { interactions } from "./routes/interactions";
// …
app.route("/interactions", interactions);
```

- [ ] **Step 6: Run the tests and the type check**

Run: `cd apps/worker && bunx vitest run test/interactions.vitest.ts && bun run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/worker bun.lock
git commit -m "feat(worker): Discord interactions endpoint with signature check"
```

---

### Task 2: Router, replies, Confirm buttons, and /help

**Files:**
- Create: `apps/worker/src/discord/respond.ts`, `apps/worker/src/discord/confirm.ts`, `apps/worker/src/discord/registry.ts`, `apps/worker/src/discord/router.ts`, `apps/worker/src/commands/help.ts`, `apps/worker/src/commands/index.ts`
- Modify: `apps/worker/src/routes/interactions.ts`, `apps/worker/test/discord.ts`
- Test: `apps/worker/test/router.vitest.ts`, `apps/worker/test/interactions.vitest.ts`

**Interfaces:**
- Consumes: `ApiError` (`src/errors.ts`), `Env`.
- Produces:
  - `respond.ts`: `MAX_CONTENT = 2000`, `fit(content: string): string`, `reply(content: string, components?: APIActionRowComponent<APIButtonComponent>[]): APIInteractionResponse`, `update(content: string): APIInteractionResponse`, `choices(list: APIApplicationCommandOptionChoice[]): APIInteractionResponse`, constants `NEEDS_ROLE`, `STALE`, `OOPS`
  - `confirm.ts`: `CANCEL_ID = "x"`, `confirmRow(action: string, args: string[], label: string)`, `parseConfirmId(id: string): { action: string; args: string[] } | null`
  - `registry.ts`: `OptionValue`, `Invocation`, `CommandContext`, `Command`, `ConfirmAction`, `Registry`, `RequestMeta` (below)
  - `router.ts`: `handleInteraction(i: APIInteraction, req: RequestMeta, registry: Registry): Promise<APIInteractionResponse>`
  - `commands/index.ts`: `REGISTRY: Registry`
  - test helpers `slash(path, options?, o?)`, `autocomplete(path, options, focused, o?)`, `button(customId, o?)`, `ALEX`, `SAM`, `MAINTAINER_ROLE`, `requestMeta(over?)`

- [ ] **Step 1: Registry types**

Create `apps/worker/src/discord/registry.ts`:
```ts
import type {
  APIApplicationCommandBasicOption,
  APIApplicationCommandOptionChoice,
  APIInteractionResponse,
} from "discord-api-types/v10";
import type { Env } from "../env";

export type OptionValue = string | number | boolean;

/** What the router knows about the HTTP request, before looking at who sent it. */
export interface RequestMeta {
  env: Env;
  exec: ExecutionContext;
  requestUrl: string;
  now: number;
}

export interface Invocation extends RequestMeta {
  /** This Worker's origin, for links back to it. */
  origin: string;
  userId: string;
  isMaintainer: boolean;
  registry: Registry;
}

export interface CommandContext extends Invocation {
  options: Record<string, OptionValue>;
}

export interface Command {
  /** "status", or group + subcommand: "world rollback". */
  path: string;
  description: string;
  maintainerOnly: boolean;
  options?: APIApplicationCommandBasicOption[];
  run(c: CommandContext): Promise<APIInteractionResponse>;
  /** `focused` is the option being typed; its partial value is in `c.options`. */
  autocomplete?(c: CommandContext, focused: string): Promise<APIApplicationCommandOptionChoice[]>;
}

/** What a Confirm button does. Always maintainer-only. */
export interface ConfirmAction {
  name: string;
  run(c: Invocation, args: string[]): Promise<APIInteractionResponse>;
}

export interface Registry {
  commands: Command[];
  actions: ConfirmAction[];
  /** Descriptions of subcommand groups, e.g. { world: "…" }. */
  groups: Record<string, string>;
}
```

- [ ] **Step 2: Test helpers for payloads**

Append to `apps/worker/test/discord.ts`:
```ts
import type { RequestMeta } from "../src/discord/registry";

export const ALEX = "100000000000000001";
export const SAM = "100000000000000002";
export const MAINTAINER_ROLE = "500000000000000001";

type Who = { user?: string; maintainer?: boolean; noMember?: boolean };
let seq = 0;

function base(type: number, who: Who) {
  const user = { id: who.user ?? ALEX, username: "someone" };
  return {
    id: `90000000000000${++seq}`,
    application_id: env.DISCORD_APP_ID,
    type,
    token: `interaction-token-${seq}`,
    version: 1,
    guild_id: env.DISCORD_GUILD_ID,
    ...(who.noMember ? { user } : { member: { user, roles: who.maintainer ? [MAINTAINER_ROLE] : [] } }),
  };
}

function optionList(options: Record<string, string | number | boolean>, focused?: string) {
  return Object.entries(options).map(([name, value]) => ({
    name,
    type: typeof value === "number" ? 4 : typeof value === "boolean" ? 5 : 3,
    value,
    ...(name === focused ? { focused: true } : {}),
  }));
}

function commandData(path: string, options: Record<string, string | number | boolean>, focused?: string) {
  const [name, sub] = path.split(" ");
  const opts = optionList(options, focused);
  return { id: "1", name, type: 1, options: sub ? [{ name: sub, type: 1, options: opts }] : opts };
}

export const slash = (path: string, options: Record<string, string | number | boolean> = {}, who: Who = {}) => ({
  ...base(2, who),
  data: commandData(path, options),
});

export const autocomplete = (path: string, options: Record<string, string | number | boolean>, focused: string, who: Who = {}) => ({
  ...base(4, who),
  data: commandData(path, options, focused),
});

export const button = (customId: string, who: Who = {}) => ({
  ...base(3, who),
  message: { id: "800000000000000001", content: "preview" },
  data: { custom_id: customId, component_type: 2 },
});

export const requestMeta = (over: Partial<RequestMeta> = {}): RequestMeta => ({
  env,
  exec: createExecutionContext(),
  requestUrl: "https://bot.test/interactions",
  now: 1_000_000,
  ...over,
});
```
(Merge the new imports into the file's import block at the top.)

- [ ] **Step 3: Write the failing router tests**

Create `apps/worker/test/router.vitest.ts`:
```ts
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
```

Append to `apps/worker/test/interactions.vitest.ts`:
```ts
import { slash } from "./discord";

describe("POST /interactions dispatch", () => {
  it("routes a slash command through the real registry", async () => {
    const r = await postInteraction(slash("help"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(r.body.data.content).toContain("`/help`");
  });
});
```
(Merge the import into the existing import block.)

- [ ] **Step 4: Run them to make sure they fail**

Run: `cd apps/worker && bunx vitest run test/router.vitest.ts test/interactions.vitest.ts`
Expected: FAIL, because `../src/discord/confirm` etc. can't be resolved.

- [ ] **Step 5: Implement the reply helpers and Confirm ids**

Create `apps/worker/src/discord/respond.ts`:
```ts
import {
  InteractionResponseType,
  MessageFlags,
  type APIActionRowComponent,
  type APIApplicationCommandOptionChoice,
  type APIButtonComponent,
  type APIInteractionResponse,
} from "discord-api-types/v10";

export const MAX_CONTENT = 2000;
export const NEEDS_ROLE = "That needs the MC Maintainer role.";
export const STALE = "Things changed since the preview. Run the command again.";
export const OOPS = "Something went wrong on my end, try again in a minute.";

const CUT_NOTE = "\n…(cut to fit Discord's limit)";

/** Discord rejects messages over 2000 characters, so cut at a line break and say so. */
export function fit(content: string): string {
  if (content.length <= MAX_CONTENT) return content;
  const cut = content.slice(0, MAX_CONTENT - CUT_NOTE.length);
  const nl = cut.lastIndexOf("\n");
  return (nl > 0 ? cut.slice(0, nl) : cut) + CUT_NOTE;
}

/** An ephemeral reply that never pings anyone. */
export function reply(content: string, components?: APIActionRowComponent<APIButtonComponent>[]): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content: fit(content), flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) },
  };
}

/** Replace the message a button was on, dropping its buttons so it can't be clicked twice. */
export function update(content: string): APIInteractionResponse {
  return { type: InteractionResponseType.UpdateMessage, data: { content: fit(content), components: [], allowed_mentions: { parse: [] } } };
}

export function choices(list: APIApplicationCommandOptionChoice[]): APIInteractionResponse {
  return { type: InteractionResponseType.ApplicationCommandAutocompleteResult, data: { choices: list.slice(0, 25) } };
}
```

Create `apps/worker/src/discord/confirm.ts`:
```ts
import { ButtonStyle, ComponentType, type APIActionRowComponent, type APIButtonComponent } from "discord-api-types/v10";

export const CANCEL_ID = "x";
const MAX_CUSTOM_ID = 100;

/** Confirm + Cancel. The action and its args travel in custom_id, so nothing is stored. */
export function confirmRow(action: string, args: string[], label: string): APIActionRowComponent<APIButtonComponent>[] {
  const id = ["c", action, ...args].join(":");
  if (id.length > MAX_CUSTOM_ID) throw new Error(`custom_id too long (${id.length}): ${id}`);
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: ButtonStyle.Danger, label, custom_id: id },
        { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "Cancel", custom_id: CANCEL_ID },
      ],
    },
  ];
}

/** "c:<action>:<a>:<b>" → { action, args }. An action whose last arg may hold colons rejoins it itself. */
export function parseConfirmId(id: string): { action: string; args: string[] } | null {
  const [c, action, ...args] = id.split(":");
  return c === "c" && action ? { action, args } : null;
}
```

- [ ] **Step 6: Implement the router**

Create `apps/worker/src/discord/router.ts`:
```ts
import { InteractionResponseType, InteractionType, type APIInteraction, type APIInteractionResponse } from "discord-api-types/v10";
import { ApiError } from "../errors";
import { CANCEL_ID, parseConfirmId } from "./confirm";
import type { Invocation, OptionValue, Registry, RequestMeta } from "./registry";
import { choices, NEEDS_ROLE, OOPS, reply, update } from "./respond";

interface RawOption {
  name: string;
  type: number;
  value?: OptionValue;
  focused?: boolean;
  options?: RawOption[];
}

const SUBCOMMAND = 1;

function flatten(data: { name: string; options?: RawOption[] }) {
  let path = data.name;
  let opts = data.options ?? [];
  if (opts[0]?.type === SUBCOMMAND) {
    path += ` ${opts[0].name}`;
    opts = opts[0].options ?? [];
  }
  const options: Record<string, OptionValue> = {};
  let focused: string | null = null;
  for (const o of opts) {
    if (o.value === undefined) continue;
    options[o.name] = o.value;
    if (o.focused) focused = o.name;
  }
  return { path, options, focused };
}

export async function handleInteraction(i: APIInteraction, req: RequestMeta, registry: Registry): Promise<APIInteractionResponse> {
  if (i.type === InteractionType.Ping) return { type: InteractionResponseType.Pong };
  const roles = i.member?.roles ?? [];
  const inv: Invocation = {
    ...req,
    origin: new URL(req.requestUrl).origin,
    userId: i.member?.user.id ?? i.user?.id ?? "",
    isMaintainer: !!req.env.MAINTAINER_ROLE_ID && roles.includes(req.env.MAINTAINER_ROLE_ID),
    registry,
  };
  const isButton = i.type === InteractionType.MessageComponent;
  const isAutocomplete = i.type === InteractionType.ApplicationCommandAutocomplete;
  try {
    if (i.type === InteractionType.ApplicationCommand || isAutocomplete) {
      const { path, options, focused } = flatten(i.data as unknown as { name: string; options?: RawOption[] });
      const cmd = registry.commands.find((c) => c.path === path);
      const allowed = !!cmd && (!cmd.maintainerOnly || inv.isMaintainer);
      if (isAutocomplete) {
        if (!allowed || !cmd.autocomplete || !focused) return choices([]);
        return choices(await cmd.autocomplete({ ...inv, options }, focused));
      }
      if (!cmd) return reply("I don't know that command. It may have been removed, so try `/help`.");
      if (!allowed) return reply(NEEDS_ROLE);
      return await cmd.run({ ...inv, options });
    }
    if (isButton) {
      const id = i.data.custom_id;
      if (id === CANCEL_ID) return update("Cancelled. Nothing changed.");
      const parsed = parseConfirmId(id);
      const action = parsed && registry.actions.find((a) => a.name === parsed.action);
      if (!parsed || !action) return update("That button doesn't do anything any more. Run the command again.");
      if (!inv.isMaintainer) return reply(NEEDS_ROLE);
      return await action.run(inv, parsed.args);
    }
    return reply("I don't know how to handle that.");
  } catch (err) {
    if (isAutocomplete) return choices([]);
    const known = err instanceof ApiError;
    if (!known) console.error(`interaction ${i.id} failed`, err);
    const message = known ? err.message : OOPS;
    return isButton ? update(message) : reply(message);
  }
}
```

- [ ] **Step 7: /help and the registry**

Create `apps/worker/src/commands/help.ts`:
```ts
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";

export const help: Command = {
  path: "help",
  description: "What each command does",
  maintainerOnly: false,
  async run(c) {
    const lines = c.registry.commands
      .filter((cmd) => !cmd.maintainerOnly || c.isMaintainer)
      .map((cmd) => `\`/${cmd.path}\` ${cmd.maintainerOnly ? "(maintainers) " : ""}— ${cmd.description}`);
    return reply(["**Minecraft bot commands**", ...lines, "", "To host, run `mc-host start` on your PC."].join("\n"));
  },
};
```

Create `apps/worker/src/commands/index.ts`:
```ts
import type { Registry } from "../discord/registry";
import { help } from "./help";

export const REGISTRY: Registry = {
  groups: {
    world: "Download, create, roll back and archive worlds",
    mod: "Mods in the active world",
    host: "The hosting session",
  },
  commands: [help],
  actions: [],
};
```

Replace the handler body in `apps/worker/src/routes/interactions.ts`:
```ts
import type { APIInteraction } from "discord-api-types/v10";
import { Hono } from "hono";
import { REGISTRY } from "../commands";
import { handleInteraction } from "../discord/router";
import { verifyDiscordRequest } from "../discord/verify";
import type { AppEnv } from "../env";

export const interactions = new Hono<AppEnv>();

interactions.post("/", async (c) => {
  const body = await c.req.text();
  const ok = await verifyDiscordRequest(
    c.env.DISCORD_PUBLIC_KEY,
    c.req.header("X-Signature-Ed25519"),
    c.req.header("X-Signature-Timestamp"),
    body,
  );
  if (!ok) return c.text("Bad request signature.", 401);
  const interaction = JSON.parse(body) as APIInteraction;
  return c.json(await handleInteraction(interaction, { env: c.env, exec: c.executionCtx, requestUrl: c.req.url, now: Date.now() }, REGISTRY));
});
```

- [ ] **Step 8: Run the tests and the type check**

Run: `cd apps/worker && bunx vitest run test/router.vitest.ts test/interactions.vitest.ts && bun run typecheck`
Expected: PASS, and no type errors. If `discord-api-types` narrows `i.data` differently on your installed version, keep the `as unknown as` cast in `flatten` and fix only the type annotations. Don't change behaviour.

- [ ] **Step 9: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): interaction router with Confirm buttons and /help"
```

---

### Task 3: Announcements when a server starts and stops

**Files:**
- Create: `apps/worker/src/discord/rest.ts`, `apps/worker/src/discord/format.ts`, `apps/worker/src/announce.ts`
- Modify: `apps/worker/src/routes/agent.ts`, `apps/worker/test/helpers.ts`, `apps/worker/test/discord.ts`
- Test: `apps/worker/test/announce.vitest.ts`, `apps/worker/test/format.vitest.ts`

**Interfaces:**
- Consumes: `requireSession`, `latestSnapshot`, `requireActiveWorld`.
- Produces:
  - `rest.ts`: `DISCORD_API = "https://discord.com/api/v10"`, `postMessage(env: Pick<Env, "DISCORD_BOT_TOKEN">, channelId: string, body: RESTPostAPIChannelMessageJSONBody): Promise<void>` (throws on a non-2xx)
  - `format.ts`: `duration(ms)`, `ago(ms)`, `mention(id)`, `savedBy(uploadedBy)`, `size(bytes)`, all returning `string`
  - `announce.ts`: `GAME_PORT = 25565`, `announceStarted(env, exec, { userId, worldName, minecraft, hostAddress })`, `announceStopped(env, exec, { userId, rev: number | null })`, `announceReleased(env, exec, { holderId, rev: number | null, savedAt: number | null, now })`, all returning `void`
  - test helpers `captureDiscord(o?: { fail?: boolean }): DiscordCall[]`, `ANNOUNCE_CHANNEL`, `announceEnv(): Env`

- [ ] **Step 1: Give `call()` an execution context**

The agent routes will call `c.executionCtx.waitUntil`, which throws without a context. In `apps/worker/test/helpers.ts`:
```ts
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
```
and in `call`, replace the `app.request` line and the lines after it with:
```ts
  const ctx = createExecutionContext();
  const res = await app.request(path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, o.env ?? env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
```

- [ ] **Step 2: The fetch capture helper**

Append to `apps/worker/test/discord.ts`:
```ts
import { vi } from "vitest";
import { envWith } from "./helpers";

export const ANNOUNCE_CHANNEL = "400000000000000001";
export const announceEnv = () => envWith({ ANNOUNCE_CHANNEL_ID: ANNOUNCE_CHANNEL });

export interface DiscordCall {
  url: string;
  method: string;
  auth: string | null;
  body: any;
}

/** Replace fetch for the rest of the test and record each call. Pair with afterEach(vi.restoreAllMocks). */
export function captureDiscord(o: { fail?: boolean } = {}): DiscordCall[] {
  const calls: DiscordCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as Request | string, init);
    calls.push({ url: req.url, method: req.method, auth: req.headers.get("Authorization"), body: await req.json().catch(() => null) });
    if (o.fail) throw new Error("Discord is down");
    return Response.json({ id: "1" });
  });
  return calls;
}
```
(Merge the imports into the top of the file.)

- [ ] **Step 3: Write the failing tests**

Create `apps/worker/test/format.vitest.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ago, duration, savedBy, size } from "../src/discord/format";

describe("format", () => {
  it("duration", () => {
    expect(duration(30_000)).toBe("less than a minute");
    expect(duration(12 * 60_000)).toBe("12 min");
    expect(duration(72 * 60_000)).toBe("1h 12m");
    expect(duration(120 * 60_000)).toBe("2h");
    expect(duration(26 * 3_600_000)).toBe("1d 2h");
  });

  it("ago", () => {
    expect(ago(10_000)).toBe("just now");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
  });

  it("savedBy", () => {
    expect(savedBy("100000000000000001")).toBe("<@100000000000000001>");
    expect(savedBy("rollback:100000000000000002")).toBe("a rollback by <@100000000000000002>");
    expect(savedBy("admin")).toBe("an import");
  });

  it("size", () => {
    expect(size(5 * 1_048_576)).toBe("5.0 MB");
    expect(size(250 * 1_048_576)).toBe("250 MB");
    expect(size(1536 * 1_048_576)).toBe("1.5 GB");
  });
});
```

Create `apps/worker/test/announce.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALEX, ANNOUNCE_CHANNEL, announceEnv, captureDiscord } from "./discord";
import { addUser, addWorld, call, envWith } from "./helpers";

let token: string;
beforeEach(async () => {
  token = await addUser(ALEX, "Alex");
  await addWorld("w1");
});
afterEach(() => vi.restoreAllMocks());

const claim = (e = announceEnv()) => call("POST", "/agent/lease/claim", { token, body: { hostAddress: "100.64.0.3" }, env: e });

describe("announcements", () => {
  it("posts when someone starts hosting", async () => {
    const posts = captureDiscord();
    expect((await claim()).status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: `https://discord.com/api/v10/channels/${ANNOUNCE_CHANNEL}/messages`,
      method: "POST",
      auth: "Bot test-bot-token",
      body: {
        content: `🟢 <@${ALEX}> is hosting **w1** (26.3) at \`100.64.0.3:25565\`. \`/join\` for how to connect.`,
        allowed_mentions: { users: [ALEX] },
      },
    });
  });

  it("posts the saved rev when they stop", async () => {
    const posts = captureDiscord();
    const { sessionId } = (await claim()).body;
    await env.DB.prepare(
      "INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at) VALUES ('w1', 3, 'k', 1, 'x', ?, 1)",
    )
      .bind(ALEX)
      .run();
    expect((await call("POST", "/agent/lease/release", { token, body: { sessionId }, env: announceEnv() })).status).toBe(200);
    expect(posts[1]!.body.content).toBe(`🔴 <@${ALEX}> stopped the server. World saved as rev 3.`);
  });

  it("says so when nothing was saved", async () => {
    const posts = captureDiscord();
    const { sessionId } = (await claim()).body;
    await call("POST", "/agent/lease/release", { token, body: { sessionId }, env: announceEnv() });
    expect(posts[1]!.body.content).toBe(`🔴 <@${ALEX}> stopped the server. Nothing was saved yet.`);
  });

  it("never fails the agent's request when Discord does", async () => {
    captureDiscord({ fail: true });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await claim()).status).toBe(200);
    expect(log).toHaveBeenCalledWith("announcement failed", expect.any(Error));
  });

  it("posts nothing without a channel, or on heartbeat", async () => {
    const posts = captureDiscord();
    const { sessionId } = (await claim(envWith({}))).body;
    await call("POST", "/agent/lease/heartbeat", { token, body: { sessionId }, env: announceEnv() });
    expect(posts).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run them to make sure they fail**

Run: `cd apps/worker && bunx vitest run test/format.vitest.ts test/announce.vitest.ts`
Expected: FAIL, because `../src/discord/format` can't be resolved and there are no posts.

- [ ] **Step 5: Implement**

Create `apps/worker/src/discord/format.ts`:
```ts
export function duration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const ago = (ms: number): string => (ms < 60_000 ? "just now" : `${duration(ms)} ago`);

export const mention = (id: string): string => `<@${id}>`;

/** snapshots.uploaded_by: a Discord id, "rollback:<id>", or "admin" for an import. */
export function savedBy(uploadedBy: string): string {
  if (/^\d+$/.test(uploadedBy)) return mention(uploadedBy);
  if (uploadedBy.startsWith("rollback:")) return `a rollback by ${mention(uploadedBy.slice("rollback:".length))}`;
  return "an import";
}

export function size(bytes: number): string {
  const mb = bytes / 1_048_576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
```

Create `apps/worker/src/discord/rest.ts`:
```ts
import type { RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import type { Env } from "../env";

export const DISCORD_API = "https://discord.com/api/v10";

export async function postMessage(
  env: Pick<Env, "DISCORD_BOT_TOKEN">,
  channelId: string,
  body: RESTPostAPIChannelMessageJSONBody,
): Promise<void> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/alexvtejeda/minecraft-discord-bot, 0.1.0)",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status} to a channel post: ${(await res.text()).slice(0, 300)}`);
}
```

Create `apps/worker/src/announce.ts`:
```ts
import { ago, mention } from "./discord/format";
import { postMessage } from "./discord/rest";
import type { Env } from "./env";

export const GAME_PORT = 25565;

/** Fire and forget: the request that triggered it never waits on Discord or fails because of it. */
function announce(env: Env, exec: ExecutionContext, content: string, ping: string): void {
  if (!env.ANNOUNCE_CHANNEL_ID) return;
  exec.waitUntil(
    postMessage(env, env.ANNOUNCE_CHANNEL_ID, { content, allowed_mentions: { users: [ping] } }).catch((err) =>
      console.error("announcement failed", err),
    ),
  );
}

export function announceStarted(
  env: Env,
  exec: ExecutionContext,
  o: { userId: string; worldName: string; minecraft: string; hostAddress: string },
): void {
  announce(
    env,
    exec,
    `🟢 ${mention(o.userId)} is hosting **${o.worldName}** (${o.minecraft}) at \`${o.hostAddress}:${GAME_PORT}\`. \`/join\` for how to connect.`,
    o.userId,
  );
}

export function announceStopped(env: Env, exec: ExecutionContext, o: { userId: string; rev: number | null }): void {
  const saved = o.rev ? `World saved as rev ${o.rev}.` : "Nothing was saved yet.";
  announce(env, exec, `🔴 ${mention(o.userId)} stopped the server. ${saved}`, o.userId);
}

export function announceReleased(
  env: Env,
  exec: ExecutionContext,
  o: { holderId: string; rev: number | null; savedAt: number | null; now: number },
): void {
  const saved = o.rev && o.savedAt !== null ? `Last save: rev ${o.rev}, ${ago(o.now - o.savedAt)}.` : "There's no save yet.";
  announce(env, exec, `🔴 A maintainer released ${mention(o.holderId)}'s hosting session. ${saved}`, o.holderId);
}
```

In `apps/worker/src/routes/agent.ts`, import `announceStarted, announceStopped` from `"../announce"`, then change the claim and release handlers to:
```ts
agent.post("/lease/claim", async (c) => {
  const { hostAddress } = await readBody(c, ClaimRequestSchema);
  const world = await requireActiveWorld(c.env.DB);
  const body: ClaimResponse = await claimLease(c.env.DB, { userId: c.var.userId, hostAddress, worldId: world.id, now: Date.now() });
  announceStarted(c.env, c.executionCtx, { userId: c.var.userId, worldName: world.name, minecraft: world.mc_version, hostAddress });
  return c.json(body);
});
```
```ts
agent.post("/lease/release", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  const lease = await requireSession(c.env.DB, sessionId);
  await releaseLease(c.env.DB, sessionId);
  const latest = await latestSnapshot(c.env.DB, lease.world_id);
  announceStopped(c.env, c.executionCtx, { userId: c.var.userId, rev: latest?.rev ?? null });
  const body: Ok = { ok: true };
  return c.json(body);
});
```

- [ ] **Step 6: Run the whole Worker suite and the type check**

Run: `cd apps/worker && bun run test && bun run typecheck`
Expected: every test passes, including the Phase 2a agent tests (they now run with an execution context), and there are no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): announce when hosting starts and stops"
```

---

### Task 4: The modpack route, /modpack and /world download

**Files:**
- Create: `apps/worker/src/mrpack.ts`, `apps/worker/src/routes/modpack.ts`, `apps/worker/src/commands/common.ts`, `apps/worker/src/commands/modpack.ts`, `apps/worker/src/commands/world-download.ts`
- Modify: `apps/worker/src/index.ts`, `apps/worker/src/commands/index.ts`, `apps/worker/test/helpers.ts`
- Test: `apps/worker/test/modpack.vitest.ts`

**Interfaces:**
- Consumes: `buildMrpack`, `isVanillaCompatible`, `parseLock` (`@mc/profile`); `activeWorld`, `latestSnapshot`, `WorldRow`; `storageFor`; `reply`; `ago`, `size`.
- Produces:
  - `mrpack.ts`: `modpackUrl(origin: string, worldId: string): string`, `worldMrpack(world: WorldRow): Promise<Uint8Array>`
  - `commands/common.ts`: `NO_WORLD: string`, `hostingNow(holderId: string): string`
  - commands `modpack`, `worldDownload`
  - test helpers: `lockEntry(slug, side, over?)`, and `addWorld(id?, status?, files?, profileOver?)` / `worldFiles(over?, files?)` that accept lock files

- [ ] **Step 1: Test helpers for worlds with mods**

In `apps/worker/test/helpers.ts`, import `type LockEntry, type Side` from `@mc/profile`, and change `worldFiles` and `addWorld` to:
```ts
export function lockEntry(slug: string, side: Side, over: Partial<LockEntry> = {}): LockEntry {
  return {
    slug,
    projectId: slug.toUpperCase(),
    versionId: `${slug}-v1`,
    versionNumber: "1.0.0",
    filename: `${slug}-1.0.0.jar`,
    url: `https://cdn.modrinth.com/data/${slug.toUpperCase()}/versions/${slug}-v1/${slug}-1.0.0.jar`,
    sha1: `sha1-${slug}`,
    sha512: `sha512-${slug}`,
    size: 100,
    side,
    clientOptional: false,
    auto: false,
    prerelease: false,
    ...over,
  };
}

/** A matching profile + lockfile pair for world creation. */
export async function worldFiles(over: Record<string, unknown> = {}, files: LockEntry[] = []) {
  const profile = makeProfile(over);
  const lockfile: Lockfile = {
    lockfileVersion: 1,
    profile: profile.name,
    profileHash: await profileHash(profile),
    minecraft: profile.minecraft,
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files,
  };
  return { profile, lockfile };
}

/** Insert a world row directly (id doubles as its name). */
export async function addWorld(
  id = "w1",
  status: "active" | "archived" = "active",
  files: LockEntry[] = [],
  profileOver: Record<string, unknown> = {},
): Promise<void> {
  const { profile, lockfile } = await worldFiles(profileOver, files);
  await env.DB.prepare(
    "INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at) VALUES (?, ?, '26.3', ?, ?, ?, 0, 1)",
  )
    .bind(id, id, JSON.stringify(profile), JSON.stringify(lockfile), status)
    .run();
}

/** Insert a snapshot row and put its object in R2. */
export async function addSnapshot(worldId: string, rev: number, o: { by?: string; at?: number; data?: string } = {}): Promise<string> {
  const key = `worlds/${worldId}/${rev}-00000000-0000-0000-0000-00000000000${rev % 10}.zip`;
  const data = o.data ?? `rev ${rev}`;
  await env.BUCKET.put(key, data);
  await env.DB.prepare("INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at) VALUES (?, ?, ?, ?, 'x', ?, ?)")
    .bind(worldId, rev, key, data.length, o.by ?? "100000000000000001", o.at ?? rev * 1000)
    .run();
  return key;
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/worker/test/modpack.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { postInteraction, slash } from "./discord";
import { addSnapshot, addWorld, lockEntry } from "./helpers";

const MODS = [
  lockEntry("lithium", "server"),
  lockEntry("waystones", "both"),
  lockEntry("voicechat", "both", { clientOptional: true }),
  lockEntry("sodium", "client-optional", { clientOptional: true }),
];

async function getPack(file: string) {
  const res = await app.request(`/modpack/${file}`, {}, env);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe("GET /modpack/:file", () => {
  beforeEach(() => addWorld("w1", "active", MODS, { description: "Test world" }));

  it("builds the .mrpack from the pinned lockfile", async () => {
    const { res, bytes } = await getPack("w1.mrpack");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-modrinth-modpack+zip");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="w1.mrpack"');
    const index = JSON.parse(strFromU8(unzipSync(bytes)["modrinth.index.json"]!));
    expect(index.name).toBe("w1");
    expect(index.summary).toBe("Test world");
    expect(index.files.map((f: { path: string }) => f.path)).toEqual([
      "mods/waystones-1.0.0.jar",
      "mods/voicechat-1.0.0.jar",
      "mods/sodium-1.0.0.jar",
    ]);
    expect(index.files[1].env.client).toBe("optional");
  });

  it("gives the same bytes every time", async () => {
    expect((await getPack("w1.mrpack")).bytes).toEqual((await getPack("w1.mrpack")).bytes);
  });

  it("is a 404 for an unknown world or a bad name", async () => {
    expect((await getPack("nope.mrpack")).res.status).toBe(404);
    expect((await getPack("w1.zip")).res.status).toBe(404);
  });
});

describe("/modpack", () => {
  it("links the active world's pack", async () => {
    await addWorld("w1", "active", MODS);
    const r = await postInteraction(slash("modpack"));
    // app.request() gives the Worker the origin http://localhost.
    expect(r.body.data.content).toContain("http://localhost/modpack/w1.mrpack");
    expect(r.body.data.content).toContain("Add Instance → Import");
  });

  it("says when every player needs it, and when it's optional", async () => {
    await addWorld("w1", "active", MODS);
    expect((await postInteraction(slash("modpack"))).body.data.content).toContain("Everyone needs it");
    await env.DB.prepare("DELETE FROM worlds").run();
    await addWorld("w2", "active", [lockEntry("lithium", "server")]);
    expect((await postInteraction(slash("modpack"))).body.data.content).toContain("optional on this world");
  });

  it("points to /world new without an active world", async () => {
    expect((await postInteraction(slash("modpack"))).body.data.content).toBe(
      "There's no active world. A maintainer can start one with `/world new`.",
    );
  });
});

describe("/world download", () => {
  it("links the latest snapshot for an hour", async () => {
    await addWorld("w1");
    await addSnapshot("w1", 1);
    await addSnapshot("w1", 2, { data: "the second save" });
    const r = await postInteraction(slash("world download"));
    const content: string = r.body.data.content;
    expect(content).toContain("**w1** rev 2");
    expect(content).toContain("The link works for 1 hour.");
    const url = /(http\S+)/.exec(content)![1]!;
    expect(await (await app.request(url, {}, env)).text()).toBe("the second save");
  });

  it("says when there's nothing saved yet", async () => {
    await addWorld("w1");
    expect((await postInteraction(slash("world download"))).body.data.content).toBe(
      "**w1** hasn't been saved yet, so there's nothing to download.",
    );
  });
});
```
- [ ] **Step 3: Run them to make sure they fail**

Run: `cd apps/worker && bunx vitest run test/modpack.vitest.ts`
Expected: FAIL, with 404s from `/modpack/…` and "I don't know that command" replies.

- [ ] **Step 4: Implement**

Create `apps/worker/src/mrpack.ts`:
```ts
import { buildMrpack, parseLock } from "@mc/profile";
import type { WorldRow } from "./worlds";

export const modpackUrl = (origin: string, worldId: string): string => `${origin}/modpack/${worldId}.mrpack`;

/** Built on request from the world's pinned lockfile, so there's nothing in R2 to keep in sync. */
export function worldMrpack(world: WorldRow): Promise<Uint8Array> {
  const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
  const profile = JSON.parse(world.profile_json) as { description?: string };
  return buildMrpack(lock, { name: world.name, summary: profile.description });
}
```

Create `apps/worker/src/routes/modpack.ts`:
```ts
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { worldMrpack } from "../mrpack";
import type { WorldRow } from "../worlds";

/** Unauthenticated so Prism can import straight from the URL. The pack only holds Modrinth links. */
export const modpack = new Hono<AppEnv>();

modpack.get("/:file", async (c) => {
  const m = /^([A-Za-z0-9-]{1,64})\.mrpack$/.exec(c.req.param("file"));
  const world = m ? await c.env.DB.prepare("SELECT * FROM worlds WHERE id = ?").bind(m[1]).first<WorldRow>() : null;
  if (!world) return c.text("There's no modpack at this address. Run /modpack in Discord for the current link.", 404);
  return new Response(await worldMrpack(world), {
    headers: {
      "Content-Type": "application/x-modrinth-modpack+zip",
      "Content-Disposition": `attachment; filename="${world.name}.mrpack"`,
      "Cache-Control": "no-cache",
    },
  });
});
```

In `apps/worker/src/index.ts`: `import { modpack } from "./routes/modpack";` and `app.route("/modpack", modpack);`.

Create `apps/worker/src/commands/common.ts`:
```ts
import { mention } from "../discord/format";

export const NO_WORLD = "There's no active world. A maintainer can start one with `/world new`.";

export const hostingNow = (holderId: string): string =>
  `${mention(holderId)} is hosting right now. Wait for them to stop, or use \`/host release\` if the session is stuck.`;
```

Create `apps/worker/src/commands/modpack.ts`:
```ts
import { isVanillaCompatible, parseLock } from "@mc/profile";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { modpackUrl } from "../mrpack";
import { activeWorld } from "../worlds";
import { NO_WORLD } from "./common";

export const modpack: Command = {
  path: "modpack",
  description: "The modpack link for the current world, for Prism Launcher",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
    const who = isVanillaCompatible(lock)
      ? `The modpack is optional on this world: any vanilla ${lock.minecraft} client can join.`
      : "Everyone needs it to join this world.";
    return reply(
      [
        `**${world.name}** modpack: ${modpackUrl(c.origin, world.id)}`,
        "In Prism Launcher: Add Instance → Import, then paste the link.",
        who,
      ].join("\n"),
    );
  },
};
```

Create `apps/worker/src/commands/world-download.ts`:
```ts
import { ago, size } from "../discord/format";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { storageFor } from "../storage";
import { activeWorld, latestSnapshot } from "../worlds";
import { NO_WORLD } from "./common";

export const worldDownload: Command = {
  path: "world download",
  description: "A download link for the latest save of the current world",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const latest = await latestSnapshot(c.env.DB, world.id);
    if (!latest) return reply(`**${world.name}** hasn't been saved yet, so there's nothing to download.`);
    const url = await storageFor(c.env, c.requestUrl).getUrl(latest.r2_key);
    return reply(
      [
        `**${world.name}** rev ${latest.rev} (${size(latest.size)}, saved ${ago(c.now - latest.created_at)}): ${url}`,
        "The link works for 1 hour.",
      ].join("\n"),
    );
  },
};
```

In `apps/worker/src/commands/index.ts`, import both and set `commands: [help, modpack, worldDownload]`.

- [ ] **Step 5: Run the tests and the type check**

Run: `cd apps/worker && bunx vitest run test/modpack.vitest.ts && bun run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): modpack URL, /modpack and /world download"
```

---

### Task 5: /status, /join and /mod list

**Files:**
- Create: `apps/worker/src/commands/status.ts`, `apps/worker/src/commands/join.ts`, `apps/worker/src/commands/mod-list.ts`
- Modify: `apps/worker/src/commands/index.ts`
- Test: `apps/worker/test/info-commands.vitest.ts`

**Interfaces:**
- Consumes: `activeWorld`, `latestSnapshot`, `readLease`, `isHeld`, `claimLease` (tests); `GAME_PORT`; `modpackUrl`; `NO_WORLD`; `ago`, `duration`, `mention`, `savedBy`; `reply`.
- Produces: commands `status`, `join`, `modList`.

- [ ] **Step 1: A helper for "hosting since"**

A lease claimed 72 minutes ago has already expired (the lease lasts 10 minutes without a
heartbeat), so tests that need a long-running host claim in the past and then heartbeat. Add to
`apps/worker/test/helpers.ts` (import `claimLease, LEASE_MS` from `"../src/lease"`):
```ts
/** Claim the lease as if hosting started `sinceMs` ago, with a fresh heartbeat. */
export async function hostSince(userId: string, worldId: string, sinceMs: number, hostAddress = "100.64.0.3") {
  const now = Date.now();
  const lease = await claimLease(env.DB, { userId, hostAddress, worldId, now: now - sinceMs });
  await env.DB.prepare("UPDATE lease SET expires_at = ? WHERE id = 1").bind(now + LEASE_MS).run();
  return lease;
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/worker/test/info-commands.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimLease } from "../src/lease";
import { ALEX, postInteraction, slash } from "./discord";
import { addSnapshot, addUser, addWorld, hostSince, lockEntry } from "./helpers";

const content = async (path: string) => (await postInteraction(slash(path))).body.data.content as string;
const hostNow = () => hostSince(ALEX, "w1", 72 * 60_000);

beforeEach(() => addUser(ALEX, "Alex"));

describe("/status", () => {
  it("shows the host, address and last save", async () => {
    await addWorld("w1");
    await addSnapshot("w1", 4, { at: Date.now() - 3 * 3_600_000 });
    await hostNow();
    const s = await content("status");
    expect(s).toContain(`🟢 <@${ALEX}> is hosting **w1** (26.3) at \`100.64.0.3:25565\`.`);
    expect(s).toContain("Hosting for 1h 12m.");
    expect(s).toContain(`Last saved 3h ago by <@${ALEX}> (rev 4).`);
  });

  it("says nobody is hosting, and how to start", async () => {
    await addWorld("w1");
    const s = await content("status");
    expect(s).toContain("Nobody is hosting **w1** (26.3) right now.");
    expect(s).toContain("It hasn't been saved yet.");
    expect(s).toContain("`mc-host start`");
  });

  it("treats an expired lease as nobody hosting", async () => {
    await addWorld("w1");
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() - 60 * 60_000 });
    expect(await content("status")).toContain("Nobody is hosting");
  });

  it("points to /world new without a world", async () => {
    expect(await content("status")).toBe("There's no active world. A maintainer can start one with `/world new`.");
  });
});

describe("/join", () => {
  it("walks through Prism, the modpack and the address", async () => {
    await addWorld("w1", "active", [lockEntry("waystones", "both")]);
    await hostNow();
    const s = await content("join");
    expect(s).toContain("https://prismlauncher.org");
    expect(s).toContain("http://localhost/modpack/w1.mrpack");
    expect(s).toContain("`100.64.0.3:25565`");
    expect(s).toContain("Ask a maintainer to get you onto the tailnet");
  });

  it("says vanilla clients work on a vanilla-compatible world, and when nobody hosts", async () => {
    await addWorld("w1", "active", [lockEntry("lithium", "server")]);
    const s = await content("join");
    expect(s).toContain("Any vanilla 26.3 client can join");
    expect(s).toContain("Nobody is hosting right now");
  });
});

describe("/mod list", () => {
  it("groups mods by side and lists the waiting ones", async () => {
    await addWorld(
      "w1",
      "active",
      [
        lockEntry("lithium", "server"),
        lockEntry("waystones", "both", { versionNumber: "2.1.0" }),
        lockEntry("balm", "both", { auto: true }),
        lockEntry("sodium", "client-optional", { clientOptional: true }),
      ],
      { waiting: ["lootr"] },
    );
    const s = await content("mod list");
    expect(s).toContain("**w1** (26.3, Fabric 0.19.5)");
    expect(s).toMatch(/__Everyone needs these__\n- waystones 2\.1\.0\n- balm 1\.0\.0 \(dependency\)/);
    expect(s).toMatch(/__Server only__\n- lithium 1\.0\.0/);
    expect(s).toMatch(/__Optional for players__\n- sodium 1\.0\.0/);
    expect(s).toContain("__Waiting for a 26.3 release__\nlootr");
  });

  it("stays under Discord's limit with a huge profile", async () => {
    await addWorld("w1", "active", Array.from({ length: 80 }, (_, i) => lockEntry(`some-long-mod-name-${i}`, "both")));
    const s = await content("mod list");
    expect(s.length).toBeLessThanOrEqual(2000);
    expect(s).toContain("cut to fit");
  });
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `cd apps/worker && bunx vitest run test/info-commands.vitest.ts`
Expected: FAIL with "I don't know that command".

- [ ] **Step 4: Implement**

Create `apps/worker/src/commands/status.ts`:
```ts
import { GAME_PORT } from "../announce";
import { ago, duration, mention, savedBy } from "../discord/format";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { activeWorld, latestSnapshot } from "../worlds";
import { NO_WORLD } from "./common";

export const status: Command = {
  path: "status",
  description: "Who's hosting, the address, and when the world was last saved",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const latest = await latestSnapshot(c.env.DB, world.id);
    const lease = await readLease(c.env.DB);
    const saved = latest
      ? `Last saved ${ago(c.now - latest.created_at)} by ${savedBy(latest.uploaded_by)} (rev ${latest.rev}).`
      : "It hasn't been saved yet.";
    if (isHeld(lease, c.now) && lease.world_id === world.id) {
      return reply(
        [
          `🟢 ${mention(lease.holder_id!)} is hosting **${world.name}** (${world.mc_version}) at \`${lease.host_address}:${GAME_PORT}\`.`,
          `Hosting for ${duration(c.now - (lease.claimed_at ?? c.now))}. ${saved}`,
        ].join("\n"),
      );
    }
    return reply(
      [
        `Nobody is hosting **${world.name}** (${world.mc_version}) right now.`,
        saved,
        "Anyone with mc-host can start it with `mc-host start`.",
      ].join("\n"),
    );
  },
};
```

Create `apps/worker/src/commands/join.ts`:
```ts
import { isVanillaCompatible, parseLock } from "@mc/profile";
import { GAME_PORT } from "../announce";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { modpackUrl } from "../mrpack";
import { activeWorld } from "../worlds";
import { NO_WORLD } from "./common";

export const join: Command = {
  path: "join",
  description: "How to connect to the server",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
    const url = modpackUrl(c.origin, world.id);
    const lease = await readLease(c.env.DB);
    const pack = isVanillaCompatible(lock)
      ? `Any vanilla ${lock.minecraft} client can join. For the recommended extras, import the modpack in Prism (Add Instance → Import, paste the link): ${url}`
      : `In Prism, Add Instance → Import, and paste: ${url}`;
    const address =
      isHeld(lease, c.now) && lease.world_id === world.id
        ? `Launch it and connect to \`${lease.host_address}:${GAME_PORT}\`.`
        : "Nobody is hosting right now. `/status` shows the address once someone starts.";
    return reply(
      [
        `**Joining ${world.name}** (${lock.minecraft})`,
        "1. Install Prism Launcher: https://prismlauncher.org",
        `2. ${pack}`,
        `3. ${address}`,
        "",
        "You need to be on the Minecraft tailnet to connect. Ask a maintainer to get you onto the tailnet.",
      ].join("\n"),
    );
  },
};
```

Create `apps/worker/src/commands/mod-list.ts`:
```ts
import { parseLock, type Side } from "@mc/profile";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { activeWorld } from "../worlds";
import { NO_WORLD } from "./common";

const SECTIONS: [Side, string][] = [
  ["both", "Everyone needs these"],
  ["server", "Server only"],
  ["client-optional", "Optional for players"],
];

export const modList: Command = {
  path: "mod list",
  description: "The mods pinned to the current world",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
    const waiting = (JSON.parse(world.profile_json) as { waiting?: string[] }).waiting ?? [];
    const lines = [`**${world.name}** (${lock.minecraft}, Fabric ${lock.fabricLoader})`];
    for (const [side, title] of SECTIONS) {
      const files = lock.files.filter((f) => f.side === side);
      if (!files.length) continue;
      lines.push("", `__${title}__`);
      for (const f of files) {
        const notes = [f.side === "both" && f.clientOptional ? "optional" : "", f.auto ? "dependency" : ""].filter(Boolean);
        lines.push(`- ${f.slug} ${f.versionNumber}${notes.length ? ` (${notes.join(", ")})` : ""}`);
      }
    }
    if (waiting.length) lines.push("", `__Waiting for a ${lock.minecraft} release__`, waiting.join(", "));
    return reply(lines.join("\n"));
  },
};
```

In `apps/worker/src/commands/index.ts`, import them and set `commands: [help, status, join, modpack, modList, worldDownload]`.

- [ ] **Step 5: Run the tests and the type check**

Run: `cd apps/worker && bunx vitest run test/info-commands.vitest.ts && bun run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): /status, /join and /mod list"
```

---

### Task 6: Bundled profiles and /world new

**Files:**
- Create: `apps/worker/src/profiles.ts`, `apps/worker/src/commands/world-new.ts`
- Modify: `apps/worker/src/commands/index.ts`
- Test: `apps/worker/test/world-new.vitest.ts`

**Interfaces:**
- Consumes: `validateWorldFiles`, `createWorld`, `activeWorld`, `latestSnapshot`, `readLease`, `isHeld`; `WorldNameSchema` (`@mc/protocol`); `confirmRow`; `reply`, `update`, `STALE`; `hostingNow`; `ago`.
- Produces:
  - `profiles.ts`: `BUNDLED_NAMES: string[]`, `interface Bundled { name: string; profile: Profile; lock: Lockfile }`, `bundledProfiles(): Promise<Bundled[]>`, `bundledProfile(name: string): Promise<Bundled | null>`, `withSeed(profile: Profile, seed: string | number | boolean | undefined): Profile`
  - `worldNew: Command`, `newAction: ConfirmAction` (action name `"new"`, args `[activeIdPrefix8, name, profile, ...seedParts]`)

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/test/world-new.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimLease } from "../src/lease";
import { BUNDLED_NAMES, bundledProfiles } from "../src/profiles";
import { ALEX, button, postInteraction, slash } from "./discord";
import { addSnapshot, addUser, addWorld } from "./helpers";

const M = { maintainer: true };
const worlds = () => env.DB.prepare("SELECT name, status, profile_json, lockfile_json FROM worlds ORDER BY created_at, name").all<any>();
const confirmId = (r: { body: any }) => r.body.data.components[0].components[0].custom_id as string;

beforeEach(() => addUser(ALEX, "Alex"));

describe("bundled profiles", () => {
  it("every committed profile matches its lockfile, and names fit the confirm budget", async () => {
    const all = await bundledProfiles();
    expect(all.map((b) => b.name)).toEqual(BUNDLED_NAMES);
    expect(BUNDLED_NAMES).toEqual(expect.arrayContaining(["adventure", "vanilla-plus"]));
    for (const n of BUNDLED_NAMES) expect(n.length).toBeLessThanOrEqual(20);
  });
});

describe("/world new", () => {
  it("needs the maintainer role", async () => {
    expect((await postInteraction(slash("world new", { name: "spring", profile: "adventure" }))).body.data.content).toBe(
      "That needs the MC Maintainer role.",
    );
  });

  it("creates right away when no world is active, with the seed in the profile", async () => {
    const r = await postInteraction(slash("world new", { name: "spring", profile: "vanilla-plus", seed: "-42" }, M));
    expect(r.body.data.content).toContain("Created **spring** (26.3, vanilla-plus profile)");
    expect(r.body.data.components).toBeUndefined();
    const [w] = (await worlds()).results;
    expect(w).toMatchObject({ name: "spring", status: "active" });
    expect(JSON.parse(w.profile_json).properties["level-seed"]).toBe("-42");
    expect(JSON.parse(w.lockfile_json).profile).toBe("vanilla-plus");
  });

  it("refuses bad names, taken names and unknown profiles", async () => {
    await addWorld("taken", "archived");
    const say = async (o: Record<string, string>) => (await postInteraction(slash("world new", o, M))).body.data.content as string;
    expect(await say({ name: "Bad Name", profile: "adventure" })).toMatch(/^World names must be/);
    expect(await say({ name: "a".repeat(31), profile: "adventure" })).toBe("World names can be up to 30 characters here.");
    expect(await say({ name: "taken", profile: "adventure" })).toBe('A world called "taken" already exists. Pick another name.');
    expect(await say({ name: "ok", profile: "nope" })).toBe("There's no profile called \"nope\" in this deploy.");
  });

  it("refuses while someone is hosting", async () => {
    await addWorld("w1");
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() });
    expect((await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M))).body.data.content).toContain(
      "is hosting right now",
    );
  });

  it("previews archiving the active world, then does it on Confirm", async () => {
    await addWorld("w1");
    await addSnapshot("w1", 1);
    await addSnapshot("w1", 2);
    const preview = await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M));
    expect(preview.body.data.content).toContain("This archives **w1** (rev 2");
    expect(preview.body.data.content).toContain("starts **spring** on 26.3 with the adventure profile");
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body).toMatchObject({ type: 7, data: { components: [] } });
    expect(done.body.data.content).toContain("Created **spring**");
    expect((await worlds()).results.map((w: any) => [w.name, w.status])).toEqual([
      ["w1", "archived"],
      ["spring", "active"],
    ]);
    // Archiving keeps only the last save.
    expect((await env.DB.prepare("SELECT rev FROM snapshots WHERE world_id = 'w1'").all()).results).toEqual([{ rev: 2 }]);
  });

  it("fits a 30-character name and a 32-character seed with colons in the button", async () => {
    await addWorld("w1");
    const name = "a".repeat(30);
    const seed = "s:".repeat(16);
    const preview = await postInteraction(slash("world new", { name, profile: "vanilla-plus", seed }, M));
    expect(confirmId(preview).length).toBeLessThanOrEqual(100);
    await postInteraction(button(confirmId(preview), M));
    const w = (await worlds()).results.find((x: any) => x.name === name);
    expect(JSON.parse(w.profile_json).properties["level-seed"]).toBe(seed);
  });

  it("refuses a stale Confirm and changes nothing", async () => {
    await addWorld("w1");
    const preview = await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M));
    await env.DB.prepare("UPDATE worlds SET status = 'archived' WHERE id = 'w1'").run();
    await addWorld("w2");
    const r = await postInteraction(button(confirmId(preview), M));
    expect(r.body.data.content).toBe("Things changed since the preview. Run the command again.");
    expect((await worlds()).results.map((w: any) => w.name)).not.toContain("spring");
  });

  it("refuses Confirm once someone starts hosting", async () => {
    await addWorld("w1");
    const preview = await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M));
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() });
    expect((await postInteraction(button(confirmId(preview), M))).body.data.content).toContain("is hosting right now");
    expect((await worlds()).results.map((w: any) => w.name)).toEqual(["w1"]);
  });

  it("Cancel changes nothing", async () => {
    await addWorld("w1");
    await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M));
    expect((await postInteraction(button("x", M))).body.data.content).toBe("Cancelled. Nothing changed.");
    expect((await worlds()).results.map((w: any) => w.name)).toEqual(["w1"]);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd apps/worker && bunx vitest run test/world-new.vitest.ts`
Expected: FAIL, because `../src/profiles` can't be resolved.

- [ ] **Step 3: Implement the bundled profiles**

Create `apps/worker/src/profiles.ts`:
```ts
import type { Lockfile, Profile } from "@mc/profile";
import adventure from "../../../profiles/adventure.json";
import adventureLock from "../../../profiles/adventure.lock.json";
import vanillaPlus from "../../../profiles/vanilla-plus.json";
import vanillaPlusLock from "../../../profiles/vanilla-plus.lock.json";
import { validateWorldFiles } from "./worlds";

/**
 * Profiles bundled at deploy time. To add one, import its pair here; the test in
 * world-new.vitest.ts checks every pair still matches, so a profile edited without
 * re-running `mc-host profile resolve` fails the tests instead of /world new.
 */
const RAW: [unknown, unknown][] = [
  [adventure, adventureLock],
  [vanillaPlus, vanillaPlusLock],
];

export const BUNDLED_NAMES: string[] = RAW.map(([p]) => (p as { name: string }).name);

export interface Bundled {
  name: string;
  profile: Profile;
  lock: Lockfile;
}

let cache: Promise<Bundled[]> | undefined;

export function bundledProfiles(): Promise<Bundled[]> {
  cache ??= Promise.all(
    RAW.map(async ([p, l]) => {
      const { profile, lock } = await validateWorldFiles(p, l);
      return { name: profile.name, profile, lock };
    }),
  );
  return cache;
}

export async function bundledProfile(name: string): Promise<Bundled | null> {
  return (await bundledProfiles()).find((b) => b.name === name) ?? null;
}

/** The seed lives in the world's stored profile; the agent writes it to server.properties. */
export function withSeed(profile: Profile, seed: string | number | boolean | undefined): Profile {
  if (seed === undefined || seed === "") return profile;
  return { ...profile, properties: { ...profile.properties, "level-seed": String(seed) } };
}
```

- [ ] **Step 4: Implement /world new**

Create `apps/worker/src/commands/world-new.ts`:
```ts
import { WorldNameSchema } from "@mc/protocol";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { confirmRow } from "../discord/confirm";
import { ago } from "../discord/format";
import type { Command, ConfirmAction, Invocation } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { BUNDLED_NAMES, bundledProfile, withSeed } from "../profiles";
import { activeWorld, createWorld, latestSnapshot } from "../worlds";
import { hostingNow } from "./common";

const NAME_MAX = 30;
const SEED_MAX = 32;

/** The reason a new world can't be created right now, or null. */
async function problem(c: Invocation, name: string, profileName: string, seed: string): Promise<string | null> {
  // Discord enforces these too; checking here keeps the Confirm button's custom_id under 100 characters.
  if (name.length > NAME_MAX) return `World names can be up to ${NAME_MAX} characters here.`;
  if (seed.length > SEED_MAX) return `Seeds can be up to ${SEED_MAX} characters.`;
  const valid = WorldNameSchema.safeParse(name);
  if (!valid.success) return `World names ${valid.error.issues[0]!.message}.`;
  if (await c.env.DB.prepare("SELECT 1 FROM worlds WHERE name = ?").bind(name).first()) {
    return `A world called "${name}" already exists. Pick another name.`;
  }
  if (!(await bundledProfile(profileName))) return `There's no profile called "${profileName}" in this deploy.`;
  const lease = await readLease(c.env.DB);
  if (isHeld(lease, c.now)) return hostingNow(lease.holder_id!);
  return null;
}

async function create(c: Invocation, name: string, profileName: string, seed: string, replace: boolean): Promise<string> {
  const b = (await bundledProfile(profileName))!;
  await createWorld(c.env, { name, profile: withSeed(b.profile, seed), lock: b.lock, replace, imported: false, now: c.now });
  return `Created **${name}** (${b.lock.minecraft}, ${profileName} profile). The first \`mc-host start\` pre-generates the map, which takes a while.`;
}

export const worldNew: Command = {
  path: "world new",
  description: "Start a new world from one of the bundled profiles",
  maintainerOnly: true,
  options: [
    { type: ApplicationCommandOptionType.String, name: "name", description: "Lowercase letters, digits and dashes", required: true, max_length: NAME_MAX },
    {
      type: ApplicationCommandOptionType.String,
      name: "profile",
      description: "Which mods and settings",
      required: true,
      choices: BUNDLED_NAMES.map((n) => ({ name: n, value: n })),
    },
    { type: ApplicationCommandOptionType.String, name: "seed", description: "Leave empty for a random seed", max_length: SEED_MAX },
  ],
  async run(c) {
    const name = String(c.options.name);
    const profileName = String(c.options.profile);
    const seed = c.options.seed === undefined ? "" : String(c.options.seed);
    const why = await problem(c, name, profileName, seed);
    if (why) return reply(why);
    const current = await activeWorld(c.env.DB);
    if (!current) return reply(await create(c, name, profileName, seed, false));
    const latest = await latestSnapshot(c.env.DB, current.id);
    const b = (await bundledProfile(profileName))!;
    const saved = latest ? `(rev ${latest.rev}, saved ${ago(c.now - latest.created_at)})` : "(never saved)";
    return reply(
      [
        `This archives **${current.name}** ${saved} and starts **${name}** on ${b.lock.minecraft} with the ${profileName} profile${seed ? `, seed \`${seed}\`` : ""}.`,
        "Archived worlds keep only their last save.",
      ].join("\n"),
      confirmRow("new", [current.id.slice(0, 8), name, profileName, seed], "Archive and create"),
    );
  },
};

export const newAction: ConfirmAction = {
  name: "new",
  async run(c, [activePrefix = "", name = "", profileName = "", ...seedParts]) {
    const current = await activeWorld(c.env.DB);
    if (!current || !current.id.startsWith(activePrefix)) return update(STALE);
    const seed = seedParts.join(":");
    const why = await problem(c, name, profileName, seed);
    if (why) return update(why);
    return update(await create(c, name, profileName, seed, true));
  },
};
```

In `apps/worker/src/commands/index.ts`, import them, add `worldNew` to `commands` (after `worldDownload`), and set `actions: [newAction]`.

- [ ] **Step 5: Run the tests and the type check**

Run: `cd apps/worker && bunx vitest run test/world-new.vitest.ts && bun run typecheck`
Expected: PASS, and no type errors. If the bundled-profiles test fails with "The lockfile doesn't match", a committed profile changed without `mc-host profile resolve`. Re-resolve it; don't loosen the test.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): bundled profiles and /world new"
```

---

### Task 7: /world rollback and retention of shared objects

**Files:**
- Create: `apps/worker/src/commands/world-rollback.ts`
- Modify: `apps/worker/src/worlds.ts` (`pruneWorld`), `apps/worker/src/snapshots.ts`, `apps/worker/src/commands/index.ts`
- Test: `apps/worker/test/rollback.vitest.ts`

**Interfaces:**
- Consumes: `CLEAR_LEASE`, `readLease`, `isHeld`, `leaseInfo`; `pruneWorld`, `KEEP_SNAPSHOTS`; `activeWorld`, `latestSnapshot`, `SnapshotRow`; `confirmRow`; `reply`, `update`, `STALE`; `hostingNow`; `ago`, `savedBy`.
- Produces: `rollbackTo(env: Pick<Env, "DB" | "BUCKET">, o: { worldId: string; rev: number; by: string; now: number }): Promise<number>` (the new rev); `worldRollback: Command`; `rollbackAction: ConfirmAction` (name `"rollback"`, args `[worldId, targetRev, latestRev]`).

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/test/rollback.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimLease, LEASE_MS, readLease } from "../src/lease";
import { rollbackTo } from "../src/snapshots";
import { ALEX, autocomplete, button, postInteraction, slash } from "./discord";
import { addSnapshot, addUser, addWorld } from "./helpers";

const M = { maintainer: true };
const revs = async () =>
  (await env.DB.prepare("SELECT rev, r2_key, uploaded_by FROM snapshots WHERE world_id = 'w1' ORDER BY rev").all<any>()).results;
const confirmId = (r: { body: any }) => r.body.data.components[0].components[0].custom_id as string;

let keys: string[];
beforeEach(async () => {
  await addUser(ALEX, "Alex");
  await addWorld("w1");
  keys = [];
  for (let rev = 1; rev <= 5; rev++) keys.push(await addSnapshot("w1", rev, { at: Date.now() - (6 - rev) * 3_600_000 }));
});

describe("rollbackTo", () => {
  it("adds a new rev that shares the old object, and pruning keeps that object", async () => {
    expect(await rollbackTo(env, { worldId: "w1", rev: 1, by: ALEX, now: Date.now() })).toBe(6);
    const rows = await revs();
    expect(rows.map((r) => r.rev)).toEqual([2, 3, 4, 5, 6]);
    expect(rows.at(-1)).toMatchObject({ r2_key: keys[0], uploaded_by: `rollback:${ALEX}` });
    expect(await (await env.BUCKET.get(keys[0]!))!.text()).toBe("rev 1");
    expect(await env.BUCKET.head(keys[1]!)).not.toBeNull();
  });

  it("can undo a rollback by rolling back to the rev before it", async () => {
    await rollbackTo(env, { worldId: "w1", rev: 2, by: ALEX, now: Date.now() });
    expect(await rollbackTo(env, { worldId: "w1", rev: 5, by: ALEX, now: Date.now() })).toBe(7);
    expect((await revs()).at(-1)!.r2_key).toBe(keys[4]);
  });

  it("refuses the latest rev, a pruned rev, and while someone is hosting", async () => {
    const now = Date.now();
    await expect(rollbackTo(env, { worldId: "w1", rev: 5, by: ALEX, now })).rejects.toMatchObject({ code: "conflict" });
    await expect(rollbackTo(env, { worldId: "w1", rev: 99, by: ALEX, now })).rejects.toMatchObject({ code: "not_found" });
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now });
    await expect(rollbackTo(env, { worldId: "w1", rev: 2, by: ALEX, now })).rejects.toMatchObject({ code: "lease_held" });
    expect((await revs()).length).toBe(5);
  });

  it("clears an expired session so it can't heartbeat back and save over the rollback", async () => {
    const then = Date.now() - LEASE_MS - 60_000;
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: then });
    await rollbackTo(env, { worldId: "w1", rev: 2, by: ALEX, now: Date.now() });
    expect((await readLease(env.DB)).session_id).toBeNull();
  });
});

describe("/world rollback", () => {
  it("autocompletes the kept revs except the latest, newest first", async () => {
    const r = await postInteraction(autocomplete("world rollback", { rev: "" }, "rev", M));
    expect(r.body.data.choices.map((c: any) => c.value)).toEqual([4, 3, 2, 1]);
    expect(r.body.data.choices[0].name).toBe("rev 4 — 2h ago by Alex");
    for (const c of r.body.data.choices) expect(c.name.length).toBeLessThanOrEqual(100);
  });

  it("filters autocomplete by what's typed", async () => {
    const r = await postInteraction(autocomplete("world rollback", { rev: "3" }, "rev", M));
    expect(r.body.data.choices.map((c: any) => c.value)).toEqual([3]);
  });

  it("previews, then rolls back on Confirm", async () => {
    const preview = await postInteraction(slash("world rollback", { rev: 2 }, M));
    expect(preview.body.data.content).toContain("Roll **w1** back to rev 2");
    expect(preview.body.data.content).toContain("saves it again as rev 6");
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain("rev 6 is now a copy of rev 2");
    expect((await revs()).at(-1)).toMatchObject({ rev: 6, r2_key: keys[1] });
  });

  it("refuses Confirm if a save landed after the preview", async () => {
    const preview = await postInteraction(slash("world rollback", { rev: 2 }, M));
    await addSnapshot("w1", 6);
    expect((await postInteraction(button(confirmId(preview), M))).body.data.content).toBe(
      "Things changed since the preview. Run the command again.",
    );
    expect((await revs()).at(-1)!.rev).toBe(6);
  });

  it("explains a rev that isn't kept, and the latest rev", async () => {
    expect((await postInteraction(slash("world rollback", { rev: 99 }, M))).body.data.content).toContain("Rev 99 isn't kept");
    expect((await postInteraction(slash("world rollback", { rev: 5 }, M))).body.data.content).toBe("Rev 5 is already the latest.");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd apps/worker && bunx vitest run test/rollback.vitest.ts`
Expected: FAIL, because `rollbackTo` isn't exported.

- [ ] **Step 3: Keep shared objects when pruning**

In `apps/worker/src/worlds.ts`, `pruneWorld`, replace the `doomed` line with:
```ts
  // A rollback row reuses an older row's object, so never delete a key a kept row still points at.
  const doomed = [...new Set([...dropped.map((r) => r.r2_key), ...orphans])].filter((k) => !keptKeys.has(k));
```

- [ ] **Step 4: Implement rollbackTo**

In `apps/worker/src/snapshots.ts`, import `CLEAR_LEASE, isHeld, leaseInfo` from `./lease` (next to the existing imports), and add:
```ts
/**
 * Add rev latest+1 pointing at an older rev's object, so nothing is lost and a rollback can be
 * undone. Refused while someone is hosting. An expired session is cleared so it can't heartbeat
 * back to life and commit on top of the rollback.
 */
export async function rollbackTo(
  env: Pick<Env, "DB" | "BUCKET">,
  o: { worldId: string; rev: number; by: string; now: number },
): Promise<number> {
  const db = env.DB;
  const [inserted] = await db.batch<{ rev: number }>([
    db
      .prepare(
        `INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at)
         SELECT world_id, (SELECT MAX(rev) FROM snapshots WHERE world_id = ?1) + 1, r2_key, size, sha256, ?3, ?4
         FROM snapshots
         WHERE world_id = ?1 AND rev = ?2
           AND rev < (SELECT MAX(rev) FROM snapshots WHERE world_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM lease WHERE id = 1 AND holder_id IS NOT NULL AND expires_at >= ?4)
         RETURNING rev`,
      )
      .bind(o.worldId, o.rev, `rollback:${o.by}`, o.now),
    db.prepare(`${CLEAR_LEASE} WHERE id = 1 AND holder_id IS NOT NULL AND expires_at < ?`).bind(o.now),
  ]);
  const newRev = inserted!.results[0]?.rev;
  if (newRev === undefined) {
    const lease = await readLease(db);
    if (isHeld(lease, o.now)) throw new ApiError("lease_held", "Someone is hosting right now. Roll back once they stop.", leaseInfo(lease));
    const latest = await latestSnapshot(db, o.worldId);
    if (latest?.rev === o.rev) throw new ApiError("conflict", `Rev ${o.rev} is already the latest.`);
    throw new ApiError("not_found", `Rev ${o.rev} isn't kept any more. Only the last ${KEEP_SNAPSHOTS} saves are kept.`);
  }
  try {
    await pruneWorld(env, o.worldId, KEEP_SNAPSHOTS);
  } catch (err) {
    console.error("pruning snapshots failed", err);
  }
  return newRev;
}
```

- [ ] **Step 5: Implement the command**

Create `apps/worker/src/commands/world-rollback.ts`:
```ts
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { confirmRow } from "../discord/confirm";
import { ago, savedBy } from "../discord/format";
import type { Command, ConfirmAction } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { KEEP_SNAPSHOTS, rollbackTo } from "../snapshots";
import { activeWorld, latestSnapshot, type SnapshotRow } from "../worlds";
import { hostingNow, NO_WORLD } from "./common";

type Kept = SnapshotRow & { by_name: string | null };

const kept = async (db: D1Database, worldId: string) =>
  (
    await db
      .prepare(
        `SELECT s.*, u.name AS by_name FROM snapshots s LEFT JOIN users u ON u.discord_id = s.uploaded_by
         WHERE s.world_id = ? ORDER BY s.rev DESC`,
      )
      .bind(worldId)
      .all<Kept>()
  ).results;

const byName = (s: Kept) => s.by_name ?? (s.uploaded_by.startsWith("rollback:") ? "a rollback" : "an import");

export const worldRollback: Command = {
  path: "world rollback",
  description: "Go back to an earlier save of the current world",
  maintainerOnly: true,
  options: [
    { type: ApplicationCommandOptionType.Integer, name: "rev", description: "Which save to go back to", required: true, min_value: 1, autocomplete: true },
  ],
  async autocomplete(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return [];
    const typed = String(c.options.rev ?? "");
    return (await kept(c.env.DB, world.id))
      .slice(1)
      .filter((s) => String(s.rev).startsWith(typed))
      .map((s) => ({ name: `rev ${s.rev} — ${ago(c.now - s.created_at)} by ${byName(s)}`.slice(0, 100), value: s.rev }));
  },
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const rev = Number(c.options.rev);
    const rows = await kept(c.env.DB, world.id);
    const target = rows.find((s) => s.rev === rev);
    const latest = rows[0];
    if (!target || !latest) {
      return reply(`Rev ${rev} isn't kept. Only the last ${KEEP_SNAPSHOTS} saves are kept, so pick one from the list.`);
    }
    if (rev === latest.rev) return reply(`Rev ${rev} is already the latest.`);
    const lease = await readLease(c.env.DB);
    if (isHeld(lease, c.now)) return reply(hostingNow(lease.holder_id!));
    return reply(
      [
        `Roll **${world.name}** back to rev ${rev} (saved ${ago(c.now - target.created_at)} by ${savedBy(target.uploaded_by)})?`,
        `This saves it again as rev ${latest.rev + 1}. Rev ${latest.rev} stays available, so you can roll forward again.`,
      ].join("\n"),
      confirmRow("rollback", [world.id, String(rev), String(latest.rev)], "Roll back"),
    );
  },
};

export const rollbackAction: ConfirmAction = {
  name: "rollback",
  async run(c, [worldId = "", rev = "", latestRev = ""]) {
    const world = await activeWorld(c.env.DB);
    const latest = world ? await latestSnapshot(c.env.DB, world.id) : null;
    if (!world || world.id !== worldId || String(latest?.rev) !== latestRev) return update(STALE);
    const newRev = await rollbackTo(c.env, { worldId, rev: Number(rev), by: c.userId, now: c.now });
    return update(`Rolled **${world.name}** back: rev ${newRev} is now a copy of rev ${rev}. The next \`mc-host start\` loads it.`);
  },
};
```

In `apps/worker/src/commands/index.ts`, add `worldRollback` to `commands` and `rollbackAction` to `actions`.

- [ ] **Step 6: Run the whole Worker suite and the type check**

Run: `cd apps/worker && bun run test && bun run typecheck`
Expected: every test passes, including the Phase 2a retention tests in `snapshots.vitest.ts`, and there are no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): /world rollback as a new rev sharing the old snapshot"
```

---

### Task 8: /world archive, /world repin and /host release

**Files:**
- Create: `apps/worker/src/commands/world-archive.ts`, `apps/worker/src/commands/world-repin.ts`, `apps/worker/src/commands/host-release.ts`
- Modify: `apps/worker/src/worlds.ts`, `apps/worker/src/commands/index.ts`
- Test: `apps/worker/test/maintainer-commands.vitest.ts`

**Interfaces:**
- Consumes: `CLEAR_LEASE`, `readLease`, `isHeld`, `forceRelease`, `LEASE_MS`; `pruneWorld`; `bundledProfile`, `withSeed`; `announceReleased`; `sha256Hex`, `serializeLock`, `parseLock`, `type Lockfile`, `type LockEntry`, `type Profile` (`@mc/profile`); `confirmRow`; `reply`, `update`, `STALE`; `hostingNow`, `NO_WORLD`; `ago`, `duration`, `mention`.
- Produces:
  - `worlds.ts`: `archiveWorld(env: Pick<Env, "DB" | "BUCKET">, worldId: string, now: number): Promise<void>`, `repinWorld(db: D1Database, o: { worldId: string; profile: Profile; lock: Lockfile; now: number }): Promise<void>`
  - `world-repin.ts`: `interface ModDiff { added: LockEntry[]; removed: LockEntry[]; changed: { slug: string; from: string; to: string }[] }`, `modDiff(from: Lockfile, to: Lockfile): ModDiff`
  - commands `worldArchive`, `worldRepin`, `hostRelease`; actions `archiveAction` (`"archive"`, args `[worldId]`), `repinAction` (`"repin"`, args `[worldId, lockHash12]`), `releaseAction` (`"release"`, args `[sessionPrefix16]`)

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/test/maintainer-commands.vitest.ts`:
```ts
import { serializeLock, type Lockfile } from "@mc/profile";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modDiff } from "../src/commands/world-repin";
import { claimLease, readLease } from "../src/lease";
import { bundledProfile } from "../src/profiles";
import { ALEX, announceEnv, button, captureDiscord, postInteraction, slash } from "./discord";
import { addSnapshot, addUser, addWorld, hostSince, lockEntry } from "./helpers";

const M = { maintainer: true };
const confirmId = (r: { body: any }) => r.body.data.components[0].components[0].custom_id as string;
const world = (id: string) => env.DB.prepare("SELECT * FROM worlds WHERE id = ?").bind(id).first<any>();

beforeEach(() => addUser(ALEX, "Alex"));
afterEach(() => vi.restoreAllMocks());

/** An active world pinned to an older copy of the bundled adventure lockfile, with a seed. */
async function oldAdventure(): Promise<Lockfile> {
  const b = (await bundledProfile("adventure"))!;
  // files[0] gets an older version, files[1] is left out (so re-pinning adds it), and gone-mod is extra.
  const [first, , ...rest] = b.lock.files;
  const old: Lockfile = {
    ...b.lock,
    files: [{ ...first!, versionId: "old-version", versionNumber: "0.0.1" }, ...rest, lockEntry("gone-mod", "both")],
  };
  const profile = { ...b.profile, properties: { ...b.profile.properties, "level-seed": "1234" } };
  await env.DB.prepare(
    "INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at) VALUES ('w1', 'w1', ?, ?, ?, 'active', 1, 1)",
  )
    .bind(b.lock.minecraft, JSON.stringify(profile), serializeLock(old))
    .run();
  return old;
}

describe("/world archive", () => {
  it("previews, then archives and keeps only the last save", async () => {
    await addWorld("w1");
    await addSnapshot("w1", 1);
    await addSnapshot("w1", 2);
    const preview = await postInteraction(slash("world archive", {}, M));
    expect(preview.body.data.content).toContain("Archive **w1**?");
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain("Archived **w1**");
    expect((await world("w1")).status).toBe("archived");
    expect((await env.DB.prepare("SELECT rev FROM snapshots").all()).results).toEqual([{ rev: 2 }]);
    expect((await postInteraction(slash("status"))).body.data.content).toContain("There's no active world");
  });

  it("refuses Confirm once someone starts hosting", async () => {
    await addWorld("w1");
    const preview = await postInteraction(slash("world archive", {}, M));
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() });
    expect((await postInteraction(button(confirmId(preview), M))).body.data.content).toContain("is hosting right now");
    expect((await world("w1")).status).toBe("active");
  });
});

describe("/world repin", () => {
  it("diffs mods by slug", async () => {
    const from = { files: [lockEntry("a", "both"), lockEntry("b", "both"), lockEntry("c", "server")] } as Lockfile;
    const to = { files: [lockEntry("a", "both", { versionId: "a-v2", versionNumber: "2.0.0" }), lockEntry("c", "server"), lockEntry("d", "both")] } as Lockfile;
    const d = modDiff(from, to);
    expect(d.added.map((f) => f.slug)).toEqual(["d"]);
    expect(d.removed.map((f) => f.slug)).toEqual(["b"]);
    expect(d.changed).toEqual([{ slug: "a", from: "1.0.0", to: "2.0.0" }]);
  });

  it("previews the diff, then re-pins and keeps the seed", async () => {
    const old = await oldAdventure();
    const b = (await bundledProfile("adventure"))!;
    const preview = await postInteraction(slash("world repin", {}, M));
    const text: string = preview.body.data.content;
    expect(text).toContain(`+ ${b.lock.files[1]!.slug}`);
    expect(text).toContain("− gone-mod");
    expect(text).toContain(`~ ${old.files[0]!.slug} 0.0.1 → ${b.lock.files[0]!.versionNumber}`);
    await postInteraction(button(confirmId(preview), M));
    const w = await world("w1");
    expect(w.lockfile_json).toBe(serializeLock(b.lock));
    expect(JSON.parse(w.profile_json).properties["level-seed"]).toBe("1234");
  });

  it("says when there's nothing to change", async () => {
    const b = (await bundledProfile("adventure"))!;
    await env.DB.prepare(
      "INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at) VALUES ('w1', 'w1', ?, ?, ?, 'active', 1, 1)",
    )
      .bind(b.lock.minecraft, JSON.stringify(b.profile), serializeLock(b.lock))
      .run();
    expect((await postInteraction(slash("world repin", {}, M))).body.data.content).toBe(
      "**w1** already matches this deploy's adventure lockfile.",
    );
  });

  it("refuses a different Minecraft version", async () => {
    await oldAdventure();
    await env.DB.prepare("UPDATE worlds SET mc_version = '26.2'").run();
    expect((await postInteraction(slash("world repin", {}, M))).body.data.content).toContain("Changing versions needs a new world");
  });

  it("refuses a profile this deploy doesn't have", async () => {
    await addWorld("w1");
    expect((await postInteraction(slash("world repin", {}, M))).body.data.content).toBe(
      "The test profile isn't in this deploy, so there's nothing to re-pin to.",
    );
  });
});

describe("/host release", () => {
  it("previews, releases, and announces", async () => {
    const posts = captureDiscord();
    await addWorld("w1");
    await addSnapshot("w1", 3, { at: Date.now() - 25 * 60_000 });
    await hostSince(ALEX, "w1", 2 * 3_600_000);
    const preview = await postInteraction(slash("host release", {}, M), { env: announceEnv() });
    expect(preview.body.data.content).toContain(`<@${ALEX}> has been hosting for 2h`);
    const done = await postInteraction(button(confirmId(preview), M), { env: announceEnv() });
    expect(done.body.data.content).toBe(`Released <@${ALEX}>'s session. Anyone can host now.`);
    expect((await readLease(env.DB)).holder_id).toBeNull();
    expect(posts.map((p) => p.body.content)).toEqual([
      `🔴 A maintainer released <@${ALEX}>'s hosting session. Last save: rev 3, 25 min ago.`,
    ]);
  });

  it("says when nobody is hosting", async () => {
    expect((await postInteraction(slash("host release", {}, M))).body.data.content).toBe(
      "Nobody is hosting, so there's nothing to release.",
    );
  });

  it("refuses a stale Confirm after the session changed", async () => {
    await addWorld("w1");
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() });
    const preview = await postInteraction(slash("host release", {}, M));
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.9", worldId: "w1", now: Date.now() });
    expect((await postInteraction(button(confirmId(preview), M))).body.data.content).toBe(
      "Things changed since the preview. Run the command again.",
    );
    expect((await readLease(env.DB)).host_address).toBe("100.64.0.9");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd apps/worker && bunx vitest run test/maintainer-commands.vitest.ts`
Expected: FAIL, because `../src/commands/world-repin` can't be resolved.

- [ ] **Step 3: World functions**

Append to `apps/worker/src/worlds.ts` (add `type Profile, type Lockfile` to its existing `@mc/profile` import if missing):
```ts
const LEASE_HELD_SQL = "EXISTS (SELECT 1 FROM lease WHERE id = 1 AND holder_id IS NOT NULL AND expires_at >= ?2)";

/** Archive the active world and keep only its last save. Refused while someone is hosting. */
export async function archiveWorld(env: Pick<Env, "DB" | "BUCKET">, worldId: string, now: number): Promise<void> {
  const db = env.DB;
  const [archived] = await db.batch([
    db.prepare(`UPDATE worlds SET status = 'archived' WHERE id = ?1 AND status = 'active' AND NOT ${LEASE_HELD_SQL}`).bind(worldId, now),
    // Same reason as createWorld: an expired session must not heartbeat back onto an archived world.
    db.prepare(`${CLEAR_LEASE} WHERE id = 1 AND NOT ${LEASE_HELD_SQL.replace("?2", "?1")}`).bind(now),
  ]);
  if (archived!.meta.changes !== 1) {
    const lease = await readLease(db);
    if (isHeld(lease, now)) throw new ApiError("lease_held", "Someone is hosting right now. Archive once they stop.", leaseInfo(lease));
    throw new ApiError("conflict", "That world isn't the active one any more.");
  }
  await pruneWorld(env, worldId, 1);
}

/** Point the active world at a new profile and lockfile. The next `mc-host start` builds from them. */
export async function repinWorld(db: D1Database, o: { worldId: string; profile: Profile; lock: Lockfile; now: number }): Promise<void> {
  const r = await db
    .prepare(
      `UPDATE worlds SET profile_json = ?3, lockfile_json = ?4
       WHERE id = ?1 AND status = 'active' AND NOT ${LEASE_HELD_SQL}`,
    )
    .bind(o.worldId, o.now, JSON.stringify(o.profile), serializeLock(o.lock))
    .run();
  if (r.meta.changes !== 1) {
    const lease = await readLease(db);
    if (isHeld(lease, o.now)) throw new ApiError("lease_held", "Someone is hosting right now. Re-pin once they stop.", leaseInfo(lease));
    throw new ApiError("conflict", "That world isn't the active one any more.");
  }
}
```

- [ ] **Step 4: /world archive**

Create `apps/worker/src/commands/world-archive.ts`:
```ts
import { confirmRow } from "../discord/confirm";
import { ago } from "../discord/format";
import type { Command, ConfirmAction } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { activeWorld, archiveWorld, latestSnapshot } from "../worlds";
import { hostingNow, NO_WORLD } from "./common";

export const worldArchive: Command = {
  path: "world archive",
  description: "Retire the current world, keeping its last save",
  maintainerOnly: true,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const lease = await readLease(c.env.DB);
    if (isHeld(lease, c.now)) return reply(hostingNow(lease.holder_id!));
    const latest = await latestSnapshot(c.env.DB, world.id);
    const saved = latest ? `Its last save (rev ${latest.rev}, ${ago(c.now - latest.created_at)}) is kept; older ones are deleted.` : "It was never saved.";
    return reply(
      [`Archive **${world.name}**? ${saved}`, "Nobody can host until a maintainer runs `/world new`."].join("\n"),
      confirmRow("archive", [world.id], "Archive"),
    );
  },
};

export const archiveAction: ConfirmAction = {
  name: "archive",
  async run(c, [worldId = ""]) {
    const world = await activeWorld(c.env.DB);
    if (!world || world.id !== worldId) return update(STALE);
    const lease = await readLease(c.env.DB);
    if (isHeld(lease, c.now)) return update(hostingNow(lease.holder_id!));
    await archiveWorld(c.env, world.id, c.now);
    return update(`Archived **${world.name}**. Start the next one with \`/world new\`.`);
  },
};
```

- [ ] **Step 5: /world repin**

Create `apps/worker/src/commands/world-repin.ts`:
```ts
import { parseLock, serializeLock, sha256Hex, type LockEntry, type Lockfile, type Profile } from "@mc/profile";
import { confirmRow } from "../discord/confirm";
import type { Command, ConfirmAction, Invocation } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { bundledProfile, withSeed, type Bundled } from "../profiles";
import { activeWorld, repinWorld, type WorldRow } from "../worlds";
import { hostingNow, NO_WORLD } from "./common";

export interface ModDiff {
  added: LockEntry[];
  removed: LockEntry[];
  changed: { slug: string; from: string; to: string }[];
}

export function modDiff(from: Lockfile, to: Lockfile): ModDiff {
  const before = new Map(from.files.map((f) => [f.slug, f]));
  const after = new Set(to.files.map((f) => f.slug));
  return {
    added: to.files.filter((f) => !before.has(f.slug)),
    removed: from.files.filter((f) => !after.has(f.slug)),
    changed: to.files.flatMap((f) => {
      const old = before.get(f.slug);
      return old && old.versionId !== f.versionId ? [{ slug: f.slug, from: old.versionNumber, to: f.versionNumber }] : [];
    }),
  };
}

const lockHash = async (lock: Lockfile) => (await sha256Hex(serializeLock(lock))).slice(0, 12);

type Plan = { world: WorldRow; bundled: Bundled; current: Lockfile } | { message: string };

async function plan(c: Invocation): Promise<Plan> {
  const world = await activeWorld(c.env.DB);
  if (!world) return { message: NO_WORLD };
  const profileName = (JSON.parse(world.profile_json) as Profile).name;
  const bundled = await bundledProfile(profileName);
  if (!bundled) return { message: `The ${profileName} profile isn't in this deploy, so there's nothing to re-pin to.` };
  if (bundled.lock.minecraft !== world.mc_version) {
    return {
      message: `This deploy's ${profileName} lockfile is for ${bundled.lock.minecraft}, but **${world.name}** is on ${world.mc_version}. Changing versions needs a new world: \`/world new\`.`,
    };
  }
  const current = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
  if (serializeLock(current) === serializeLock(bundled.lock)) {
    return { message: `**${world.name}** already matches this deploy's ${profileName} lockfile.` };
  }
  const lease = await readLease(c.env.DB);
  if (isHeld(lease, c.now)) return { message: hostingNow(lease.holder_id!) };
  return { world, bundled, current };
}

export const worldRepin: Command = {
  path: "world repin",
  description: "Update the current world's mods to this deploy's lockfile",
  maintainerOnly: true,
  async run(c) {
    const p = await plan(c);
    if ("message" in p) return reply(p.message);
    const d = modDiff(p.current, p.bundled.lock);
    const lines = [
      ...d.added.map((f) => `+ ${f.slug} ${f.versionNumber}`),
      ...d.removed.map((f) => `− ${f.slug} ${f.versionNumber}`),
      ...d.changed.map((ch) => `~ ${ch.slug} ${ch.from} → ${ch.to}`),
    ];
    if (p.current.fabricLoader !== p.bundled.lock.fabricLoader) {
      lines.push(`~ Fabric loader ${p.current.fabricLoader} → ${p.bundled.lock.fabricLoader}`);
    }
    if (!lines.length) lines.push("(Only mod sides or dependencies changed.)");
    return reply(
      [
        `Re-pin **${p.world.name}** to this deploy's ${p.bundled.name} lockfile?`,
        "```diff",
        ...lines,
        "```",
        "Players need the updated modpack afterwards (`/modpack`). The next `mc-host start` uses the new mods.",
      ].join("\n"),
      confirmRow("repin", [p.world.id, await lockHash(p.bundled.lock)], "Re-pin"),
    );
  },
};

export const repinAction: ConfirmAction = {
  name: "repin",
  async run(c, [worldId = "", hash = ""]) {
    const p = await plan(c);
    if ("message" in p) return update(p.message);
    if (p.world.id !== worldId || (await lockHash(p.bundled.lock)) !== hash) return update(STALE);
    const seed = (JSON.parse(p.world.profile_json) as Profile).properties["level-seed"];
    await repinWorld(c.env.DB, { worldId, profile: withSeed(p.bundled.profile, seed), lock: p.bundled.lock, now: c.now });
    return update(`Re-pinned **${p.world.name}**. Everyone should grab the updated modpack with \`/modpack\`.`);
  },
};
```
The `diff` code block renders `+`/`−` lines in green and red in Discord. `fit()` still guards the length.

- [ ] **Step 6: /host release**

Create `apps/worker/src/commands/host-release.ts`:
```ts
import { announceReleased } from "../announce";
import { confirmRow } from "../discord/confirm";
import { ago, duration, mention } from "../discord/format";
import type { Command, ConfirmAction } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { forceRelease, isHeld, LEASE_MS, readLease } from "../lease";
import { latestSnapshot } from "../worlds";

const SESSION_PREFIX = 16;

export const hostRelease: Command = {
  path: "host release",
  description: "Free a stuck hosting session so someone else can host",
  maintainerOnly: true,
  async run(c) {
    const lease = await readLease(c.env.DB);
    if (!isHeld(lease, c.now)) return reply("Nobody is hosting, so there's nothing to release.");
    const lastBeat = (lease.expires_at ?? c.now) - LEASE_MS;
    return reply(
      [
        `${mention(lease.holder_id!)} has been hosting for ${duration(c.now - (lease.claimed_at ?? c.now))}. Their last heartbeat was ${ago(c.now - lastBeat)}.`,
        "Releasing lets someone else host. Anything since their last save may be lost.",
      ].join("\n"),
      confirmRow("release", [lease.session_id!.slice(0, SESSION_PREFIX)], "Release"),
    );
  },
};

export const releaseAction: ConfirmAction = {
  name: "release",
  async run(c, [sessionPrefix = ""]) {
    const lease = await readLease(c.env.DB);
    if (!isHeld(lease, c.now) || !lease.session_id?.startsWith(sessionPrefix)) return update(STALE);
    const latest = lease.world_id ? await latestSnapshot(c.env.DB, lease.world_id) : null;
    await forceRelease(c.env.DB, c.now);
    announceReleased(c.env, c.exec, { holderId: lease.holder_id!, rev: latest?.rev ?? null, savedAt: latest?.created_at ?? null, now: c.now });
    return update(`Released ${mention(lease.holder_id!)}'s session. Anyone can host now.`);
  },
};
```

In `apps/worker/src/commands/index.ts`, the final registry:
```ts
import type { Registry } from "../discord/registry";
import { help } from "./help";
import { hostRelease, releaseAction } from "./host-release";
import { join } from "./join";
import { modList } from "./mod-list";
import { modpack } from "./modpack";
import { status } from "./status";
import { archiveAction, worldArchive } from "./world-archive";
import { worldDownload } from "./world-download";
import { newAction, worldNew } from "./world-new";
import { repinAction, worldRepin } from "./world-repin";
import { rollbackAction, worldRollback } from "./world-rollback";

export const REGISTRY: Registry = {
  groups: {
    world: "Download, create, roll back and archive worlds",
    mod: "Mods in the active world",
    host: "The hosting session",
  },
  commands: [help, status, join, modpack, modList, worldDownload, worldNew, worldRollback, worldArchive, worldRepin, hostRelease],
  actions: [newAction, rollbackAction, archiveAction, repinAction, releaseAction],
};
```

- [ ] **Step 7: Run the whole Worker suite and the type check**

Run: `cd apps/worker && bun run test && bun run typecheck`
Expected: every test passes, and there are no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): /world archive, /world repin and /host release"
```

---

### Task 9: Command registration and the setup guide

**Files:**
- Create: `apps/worker/src/discord/definitions.ts`, `apps/worker/scripts/register-commands.ts`, `docs/setup/phase-3.md`
- Modify: `apps/worker/package.json`, `ROADMAP.md`
- Test: `apps/worker/test/definitions.vitest.ts`

**Interfaces:**
- Consumes: `Registry`, `Command`, `REGISTRY`.
- Produces: `toDiscordCommands(r: Registry): RESTPostAPIChatInputApplicationCommandsJSONBody[]`; `bun run --cwd apps/worker register`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/definitions.vitest.ts`:
```ts
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/commands";
import { toDiscordCommands } from "../src/discord/definitions";

const NAME = /^[a-z0-9-]{1,32}$/;

describe("toDiscordCommands", () => {
  const cmds = toDiscordCommands(REGISTRY);
  const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));

  it("registers each top-level command and group once", () => {
    expect(cmds.map((c) => c.name).sort()).toEqual(["help", "host", "join", "mod", "modpack", "status", "world"]);
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
    expect(byName.world!.default_member_permissions).toBeUndefined(); // /world download is for everyone
    expect(byName.status!.default_member_permissions).toBeUndefined();
  });

  it("puts subcommands under their group", () => {
    expect(byName.world!.options!.map((o) => o.name)).toEqual(["download", "new", "rollback", "archive", "repin"]);
    expect(byName.world!.options!.every((o) => o.type === 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/worker && bunx vitest run test/definitions.vitest.ts`
Expected: FAIL, because `../src/discord/definitions` can't be resolved.

- [ ] **Step 3: Implement the serializer**

Create `apps/worker/src/discord/definitions.ts`:
```ts
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import type { Command, Registry } from "./registry";

/**
 * Registration JSON built from the same registry the router dispatches from. A command is
 * hidden from non-maintainers (default_member_permissions "0") only if all of it is
 * maintainer-only; the router's role check is what enforces access either way.
 */
export function toDiscordCommands(r: Registry): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const top: Command[] = [];
  const groups = new Map<string, Command[]>();
  for (const c of r.commands) {
    const [group, sub] = c.path.split(" ");
    if (sub) groups.set(group!, [...(groups.get(group!) ?? []), c]);
    else top.push(c);
  }
  const hidden = (cs: Command[]) => (cs.every((c) => c.maintainerOnly) ? { default_member_permissions: "0" } : {});
  return [
    ...top.map((c) => ({
      type: ApplicationCommandType.ChatInput as const,
      name: c.path,
      description: c.description,
      options: c.options ?? [],
      ...hidden([c]),
    })),
    ...[...groups].map(([name, subs]) => ({
      type: ApplicationCommandType.ChatInput as const,
      name,
      description: r.groups[name] ?? name,
      ...hidden(subs),
      options: subs.map((s) => ({
        type: ApplicationCommandOptionType.Subcommand as const,
        name: s.path.split(" ")[1]!,
        description: s.description,
        options: s.options ?? [],
      })),
    })),
  ];
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/worker && bunx vitest run test/definitions.vitest.ts && bun run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 5: The registration script**

Create `apps/worker/scripts/register-commands.ts`:
```ts
// Registers the slash commands in one Discord server (guild commands update instantly).
// Usage: DISCORD_APP_ID=… DISCORD_GUILD_ID=… DISCORD_BOT_TOKEN=… bun run --cwd apps/worker register
import { REGISTRY } from "../src/commands";
import { toDiscordCommands } from "../src/discord/definitions";
import { DISCORD_API } from "../src/discord/rest";

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} first. See docs/setup/phase-3.md.`);
    process.exit(1);
  }
  return value;
}

const appId = need("DISCORD_APP_ID");
const guildId = need("DISCORD_GUILD_ID");
const token = need("DISCORD_BOT_TOKEN");

const res = await fetch(`${DISCORD_API}/applications/${appId}/guilds/${guildId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(toDiscordCommands(REGISTRY)),
});
if (!res.ok) {
  console.error(`Discord answered ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const registered = (await res.json()) as { name: string }[];
console.log(`Registered ${registered.length} commands: ${registered.map((c) => `/${c.name}`).join(", ")}`);
```

In `apps/worker/package.json` scripts, add `"register": "bun scripts/register-commands.ts"`.

Check that it loads under Bun without a token (it should stop at the first missing variable):

Run: `cd apps/worker && env -u DISCORD_APP_ID bun scripts/register-commands.ts; echo "exit $?"`
Expected: `Set DISCORD_APP_ID first. See docs/setup/phase-3.md.` and `exit 1`. An import error here means something under `src/commands` pulls in a Workers-only module. Fix the import rather than the script.

- [ ] **Step 6: The setup guide**

Create `docs/setup/phase-3.md`:
````markdown
# Phase 3: Discord commands

Design: [../superpowers/specs/2026-09-26-phase-3-discord-design.md](../superpowers/specs/2026-09-26-phase-3-discord-design.md)

## 1. IDs from Discord

Turn on Developer Mode (User Settings → Advanced), then right-click to **Copy ID**:
- the server → `DISCORD_GUILD_ID`
- the announcements channel → `ANNOUNCE_CHANNEL_ID`
- the `MC Maintainer` role (Server Settings → Roles) → `MAINTAINER_ROLE_ID`

From the developer portal (your application → General Information):
- Application ID → `DISCORD_APP_ID`
- Public Key → `DISCORD_PUBLIC_KEY`

Put all five in `apps/worker/wrangler.jsonc` under `vars` and commit them. None of them is a secret.

## 2. Bot token and permissions

Developer portal → Bot → **Reset Token**, then:
```bash
cd apps/worker
bunx wrangler secret put DISCORD_BOT_TOKEN
```
In the announcements channel's settings, give the bot View Channel and Send Messages.

## 3. Deploy and register

```bash
bunx wrangler deploy
DISCORD_APP_ID=<id> DISCORD_GUILD_ID=<id> DISCORD_BOT_TOKEN=<token> bun run register
```
Register again whenever a command's name, description or options change, or after adding
a profile (the `/world new` profile list is part of the registration).

## 4. Point Discord at the Worker

Developer portal → General Information → **Interactions Endpoint URL**:
`https://mc-bot.<you>.workers.dev/interactions`. Discord sends a test request when you save;
it only saves if the Worker answers it.

## 5. Hide maintainer commands

`/host` is registered hidden from everyone. In Server Settings → Integrations → your bot,
allow the `MC Maintainer` role to use `/host`. `/world` stays visible because
`/world download` is for everyone; its maintainer subcommands answer
"That needs the MC Maintainer role." for anyone else.

## 6. Adding a profile later

Add the `profiles/<name>.json` + `.lock.json` imports to `apps/worker/src/profiles.ts`, run
`bun run --cwd apps/worker test`, deploy, and register again.

## Checklist

- [ ] `/help` as a member lists no maintainer commands; as a maintainer it lists them all
- [ ] `/status`, `/join`, `/modpack`, `/mod list`, `/world download` with nobody hosting
- [ ] `mc-host start`: the 🟢 announcement appears; `/status` and `/join` show the address
- [ ] `mc-host stop`: the 🔴 announcement shows the saved rev
- [ ] Import the `/modpack` link in Prism (Add Instance → Import) and join the server
- [ ] `/world rollback` to an older rev, Confirm, then roll forward again
- [ ] `/world repin` says the world already matches
- [ ] `/host release` while hosting from a second terminal: Confirm, and the announcement appears
- [ ] `/world new test-world vanilla-plus` → preview → Cancel changes nothing
- [ ] A member without the role running `/world rollback` gets "That needs the MC Maintainer role."
````

- [ ] **Step 7: Roadmap link**

In `ROADMAP.md`, under `## Phase 3: Discord commands`, add a line after the `Design:` line:
```markdown
Setup guide: [docs/setup/phase-3.md](docs/setup/phase-3.md)
```

- [ ] **Step 8: Full suite, type checks, commit**

Run: `bun run test && bun run typecheck` (from the repo root)
Expected: the Bun tests and the Worker suite pass, and both type checks are clean.

```bash
git add apps/worker docs/setup/phase-3.md ROADMAP.md
git commit -m "feat(worker): slash command registration; phase 3 setup guide"
```
