# Phase 4: Tailnet Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A friend on a clean Windows PC runs `/setup` (or `/setup host:True`) in Discord, pastes one line into PowerShell, clicks Yes once, and is on the Minecraft tailnet, with `mc-host.exe` and a **Host Minecraft** shortcut in host mode. Maintainers can remove anyone with `/tailnet revoke`.

**Architecture:** `/setup` stores a hashed, single-use enrollment code. The Worker serves `scripts/install.ps1` at `/s/<code>` with the Worker URL, code and mode filled in. The script installs Tailscale (one UAC prompt), then redeems the code at `POST /enroll`, which mints a tagged Tailscale auth key and, in host mode, a hosting token. It then joins the tailnet and reports its node ID to `POST /enroll/device`, so `/tailnet revoke` can delete exact devices. A GitHub Actions release publishes prebuilt `mc-host` binaries. Agents send their version, and the Worker refuses outdated ones with a clear message.

**Tech Stack:** Cloudflare Worker (Hono, D1, Vitest with `@cloudflare/vitest-plugin`), Bun (agent, `bun test`, `bun build --compile`), Windows PowerShell 5.1, Tailscale API v2 (OAuth client credentials), GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-09-26-phase-4-onboarding-design.md](../specs/2026-09-26-phase-4-onboarding-design.md)

## Global Constraints

- Every user-facing message is plain English and says what to do next. Use these strings verbatim:
  - `This setup link expired. Run /setup in Discord again.`
  - `You've been removed from the Minecraft network. Ask a maintainer to let you back in.`
  - `Couldn't create your network key. Try again in a minute. If it keeps failing, tell a maintainer.`
  - `Tailscale on this PC is signed in to another network. This installer won't change it. Ask a maintainer for help.`
  - `mc-host is out of date. Run \`/setup host\` in Discord to update.`
- Enrollment code: 8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, shown as `XXXX-XXXX`, stored only as a sha256 hash, single-use, expires 15 minutes after `/setup`. `/enroll/device` accepts a code for 15 minutes after it was used.
- Tailscale auth key: single-use (`reusable: false`), not ephemeral, `preauthorized: true`, tags `["tag:mc-player"]`, `expirySeconds: 600`.
- Tailnet hostname: `mc-` + the Discord username lowercased, runs of anything outside `[a-z0-9-]` collapsed to `-`, at most 40 characters total. If nothing is left, use `mc-player-<last 4 digits of the Discord id>`.
- Agent version: `apps/agent/package.json` `version`, sent as the `X-MC-Agent-Version` header. The Worker's `MIN_AGENT_VERSION` var is `0.2.0`, and anything older or missing gets HTTP 426.
- New Worker secrets: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_CLIENT_SECRET`. Tailscale API base: `https://api.tailscale.com/api/v2`. Tailnet path segment: `-`.
- Windows only for `install.ps1`: 64-bit Windows 10/11 on AMD64, Windows PowerShell 5.1. The script runs through `irm … | iex` inside the user's own window, so it **never calls `exit`**, which would close their window. It returns or throws instead.
- Host config file: `%APPDATA%\mc-host\agent.json` = `{"workerUrl": "...", "token": "..."}`, written as UTF-8 **without** a BOM.
- Release assets: `mc-host-windows-x64.exe`, `mc-host-linux-x64`, `SHA256SUMS`, from tag `v<apps/agent version>`. Bun is pinned to `1.3.3`.
- Match the surrounding code: Worker tests are `test/*.vitest.ts` and spy on `fetch` with `vi.spyOn` (there is no `fetchMock`). Agent tests are `apps/agent/test/*.test.ts` with `bun:test`.
- Commit messages follow the repo's style (`feat(worker): …`, `feat(agent): …`, `docs: …`) and end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
  ```

## Review Focus

1. **`agent.json` written with a BOM.** PowerShell 5.1's `Set-Content -Encoding UTF8` adds one, and `JSON.parse` rejects it. The agent should still read the file. Pinned in Task 6. The script also writes without a BOM (Task 7).
2. **A code pasted in another shape** (lowercase, no dash, surrounding spaces) should still work. Pinned in Task 3 (`normalizeCode`) and Task 4 (`/enroll` with a lowercase code).
3. **Discord usernames that sanitize to nothing or run long** (`🎮`, 60 characters, dots and underscores) should still give a valid, stable hostname. Pinned in Task 4.
4. **Running `/setup` twice** should kill the first line, so only the newest one works. Pinned in Task 3.
5. **Revoking someone who never ran `/setup`, or who is hosting right now,** should still block them, explain what happens, and never crash. Pinned in Task 5.

---

## File map

**Worker (`apps/worker`)**
- `migrations/0002_onboarding.sql`: new `enrollments` and `devices` tables.
- `src/version.ts`: version comparison and the `/agent` middleware.
- `src/tailscale.ts`: OAuth token, `mintAuthKey`, `deleteDevice`.
- `src/enroll.ts`: codes, enrollment rows, hostnames.
- `src/users.ts` (modify): `ensurePlayer`, `revokeUser`, `isRevoked`.
- `src/routes/enroll.ts`: `GET /s/:code`, `POST /enroll`, `POST /enroll/device`.
- `src/commands/setup.ts`, `src/commands/tailnet-revoke.ts`: slash commands.
- `src/text-modules.d.ts`: typing for `import … from "*.ps1"`.
- `src/env.ts`, `src/errors.ts`, `src/index.ts`, `src/discord/registry.ts`, `src/discord/router.ts`, `src/commands/index.ts`, `src/commands/help.ts`, `src/routes/agent.ts`, `wrangler.jsonc`, `vitest.config.ts` (modify).
- Tests: `test/version.vitest.ts`, `test/tailscale.vitest.ts`, `test/tailscale.ts` (fake), `test/setup.vitest.ts`, `test/enroll.vitest.ts`, `test/tailnet-revoke.vitest.ts`. Modify `test/helpers.ts`, `test/discord.ts`, `test/definitions.vitest.ts`.

**Shared:** `packages/protocol/src/index.ts`: new error codes, header name, enroll schemas.

**Agent (`apps/agent`)**
- `src/version.ts`: `VERSION`.
- `src/host/api.ts`, `src/cli.ts`, `src/commands.ts`, `src/host/signals.ts`, `src/host/run.ts`, `src/host/config.ts`, `package.json` (modify). Root `tsconfig.json` (`resolveJsonModule`).
- Tests: modify `test/api.test.ts`, `test/cli.test.ts`, `test/signals.test.ts`, `test/host-config.test.ts`.

**Other:** `scripts/install.ps1`, `.github/workflows/release.yml`, `docs/setup/phase-4.md`, `ROADMAP.md`, the spec (small corrections).

---

### Task 1: Agent version check

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/worker/src/errors.ts`, `apps/worker/src/env.ts`, `apps/worker/src/routes/agent.ts`, `apps/worker/wrangler.jsonc`
- Create: `apps/worker/src/version.ts`
- Modify: `apps/worker/test/helpers.ts`
- Create: `apps/worker/test/version.vitest.ts`
- Create: `apps/agent/src/version.ts`
- Modify: `apps/agent/package.json`, `tsconfig.json` (root), `apps/agent/src/host/api.ts`, `apps/agent/src/cli.ts`, `apps/agent/src/commands.ts`
- Test: `apps/agent/test/api.test.ts`, `apps/agent/test/cli.test.ts`

**Interfaces:**
- Produces: `ERROR_CODES` gains `"expired"` (410), `"outdated"` (426), `"upstream"` (502). `AGENT_VERSION_HEADER = "X-MC-Agent-Version"` from `@mc/protocol`. `Env.MIN_AGENT_VERSION: string`. `atLeast(version: string | undefined, min: string): boolean` and `versionCheck` middleware in `apps/worker/src/version.ts`. `VERSION: string` in `apps/agent/src/version.ts`. `call()` in `test/helpers.ts` takes `agentVersion?: string | null` (default `"999.0.0"`, `null` omits the header).

- [ ] **Step 1: Protocol additions**

In `packages/protocol/src/index.ts`, extend `ERROR_CODES` and add the header name right after `ErrorCode`:

```ts
export const ERROR_CODES = [
  "unauthorized",
  "bad_request",
  "not_found",
  "no_active_world",
  "lease_held",
  "lease_lost",
  "stale_rev",
  "conflict",
  "upload_missing",
  "expired",
  "outdated",
  "upstream",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every agent request carries its mc-host version, so the Worker can turn away outdated ones. */
export const AGENT_VERSION_HEADER = "X-MC-Agent-Version";
```

In `apps/worker/src/errors.ts`, widen the status map:

```ts
const STATUS: Record<ErrorCode, 400 | 401 | 404 | 409 | 410 | 426 | 500 | 502> = {
  unauthorized: 401,
  bad_request: 400,
  not_found: 404,
  no_active_world: 404,
  lease_held: 409,
  lease_lost: 409,
  stale_rev: 409,
  conflict: 409,
  upload_missing: 409,
  expired: 410,
  outdated: 426,
  upstream: 502,
  internal: 500,
};
```

- [ ] **Step 2: Write the failing Worker test**

Add `MIN_AGENT_VERSION: string;` to `Env` in `apps/worker/src/env.ts`:

```ts
  DISCORD_BOT_TOKEN: string;
  /** Agents older than this (or sending no version) get 426 and are told to update. */
  MIN_AGENT_VERSION: string;
}
```

Add `"MIN_AGENT_VERSION": "0.2.0"` to `vars` in `apps/worker/wrangler.jsonc` (after `MAINTAINER_ROLE_ID`). The test pool reads `wrangler.jsonc`, so tests see it too.

In `apps/worker/test/helpers.ts`, add `MIN_AGENT_VERSION: env.MIN_AGENT_VERSION,` to `envWith` (after `DISCORD_BOT_TOKEN`), and make `call` send the header:

```ts
export async function call(
  method: string,
  path: string,
  o: { token?: string; admin?: boolean; body?: unknown; env?: Env; agentVersion?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (o.admin) headers.Authorization = `Bearer ${ADMIN_SECRET}`;
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  // Always newer than MIN_AGENT_VERSION unless a test says otherwise.
  const agentVersion = o.agentVersion === undefined ? "999.0.0" : o.agentVersion;
  if (agentVersion !== null) headers["X-MC-Agent-Version"] = agentVersion;
```

(The rest of `call` is unchanged.)

Create `apps/worker/test/version.vitest.ts`:

```ts
import { describe, expect, it } from "vitest";
import { atLeast } from "../src/version";
import { addUser, call } from "./helpers";

const OUTDATED = { error: "outdated", message: "mc-host is out of date. Run `/setup host` in Discord to update." };

describe("atLeast", () => {
  it("compares versions number by number", () => {
    expect(atLeast("0.2.0", "0.2.0")).toBe(true);
    expect(atLeast("0.10.0", "0.9.9")).toBe(true);
    expect(atLeast("1.0.0", "0.2.0")).toBe(true);
    expect(atLeast("0.1.9", "0.2.0")).toBe(false);
  });

  it("treats a missing or odd version as too old", () => {
    expect(atLeast(undefined, "0.2.0")).toBe(false);
    expect(atLeast("v0.2.0", "0.2.0")).toBe(false);
    expect(atLeast("0.2", "0.2.0")).toBe(false);
  });
});

describe("agent version check", () => {
  it("turns away an agent below MIN_AGENT_VERSION with 426", async () => {
    const token = await addUser();
    const r = await call("GET", "/agent/manifest", { token, agentVersion: "0.1.9" });
    expect(r.status).toBe(426);
    expect(r.body).toEqual(OUTDATED);
  });

  it("turns away an agent that sends no version", async () => {
    const token = await addUser();
    const r = await call("GET", "/agent/manifest", { token, agentVersion: null });
    expect(r.status).toBe(426);
  });

  it("checks the version before the token, so an old agent hears it needs updating", async () => {
    expect((await call("GET", "/agent/manifest", { token: "wrong", agentVersion: "0.1.0" })).status).toBe(426);
  });

  it("lets a current agent through", async () => {
    const token = await addUser();
    const r = await call("GET", "/agent/manifest", { token, agentVersion: "0.2.0" });
    expect(r.status).toBe(404); // no active world, which is past the version check
    expect(r.body.error).toBe("no_active_world");
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd apps/worker && bunx vitest run test/version.vitest.ts`
Expected: FAIL, `Cannot find module '../src/version'`.

- [ ] **Step 4: Implement the Worker side**

Create `apps/worker/src/version.ts`:

```ts
import { AGENT_VERSION_HEADER } from "@mc/protocol";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env";
import { ApiError } from "./errors";

export const OUTDATED = "mc-host is out of date. Run `/setup host` in Discord to update.";

function parse(v: string | undefined): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  return m ? m.slice(1).map(Number) : null;
}

/** "0.10.0" ≥ "0.9.9". A missing or unparseable version counts as too old. */
export function atLeast(version: string | undefined, min: string): boolean {
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

export const versionCheck = createMiddleware<AppEnv>(async (c, next) => {
  if (c.env.MIN_AGENT_VERSION && !atLeast(c.req.header(AGENT_VERSION_HEADER), c.env.MIN_AGENT_VERSION)) {
    throw new ApiError("outdated", OUTDATED);
  }
  await next();
});
```

In `apps/worker/src/routes/agent.ts`, import it and register it before `agentAuth`:

```ts
import { versionCheck } from "../version";
…
export const agent = new Hono<AppEnv>();
agent.use("*", versionCheck);
agent.use("*", agentAuth);
```

- [ ] **Step 5: Run the Worker tests**

Run: `cd apps/worker && bunx vitest run`
Expected: all PASS. The existing `agent.vitest.ts` and `snapshots.vitest.ts` go through `call`, which now sends `999.0.0`. If a test calls `app.request` on `/agent/*` directly without `call`, add the `X-MC-Agent-Version: 999.0.0` header there.

- [ ] **Step 6: Write the failing agent tests**

In `apps/agent/test/api.test.ts`, record the version header next to `seen` (kept separate so the existing `toEqual` assertions on `seen[0]` still hold), and add a test:

```ts
import { VERSION } from "../src/version";

type Seen = { url: string; method: string; auth: string | null; body: unknown };
const versions: (string | null)[] = [];
function fakeFetch(reply: (url: string) => Response | Promise<Response>): { fetch: Fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? "GET", auth: headers.get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    versions.push(headers.get("X-MC-Agent-Version"));
    return reply(url);
  };
  return { fetch, seen };
}

test("every request says which mc-host version sent it", async () => {
  versions.length = 0;
  const { fetch } = fakeFetch(() => json({ rev: 4 }));
  const api = createAgentApi({ workerUrl: "https://w.test", token: "t", fetch });
  await api.commit({ sessionId: "s".repeat(16), rev: 4, key: "k", size: 1, sha256: SHA });
  expect(versions).toEqual([VERSION]);
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
```

In `apps/agent/test/cli.test.ts`, add:

```ts
test("--version and version print the version", () => {
  expect(parseCommand(["--version"])).toEqual({ kind: "version" });
  expect(parseCommand(["version"])).toEqual({ kind: "version" });
});
```

- [ ] **Step 7: Run them to make sure they fail**

Run: `bun test apps/agent/test/api.test.ts apps/agent/test/cli.test.ts`
Expected: FAIL, `Cannot find module '../src/version'`.

- [ ] **Step 8: Implement the agent side**

Set `"version": "0.2.0"` in `apps/agent/package.json`.

Add `"resolveJsonModule": true,` to `compilerOptions` in the root `tsconfig.json`.

Create `apps/agent/src/version.ts`:

```ts
import pkg from "../package.json";

/** Baked in by `bun build --compile`; the release tag must match it. */
export const VERSION: string = pkg.version;
```

In `apps/agent/src/host/api.ts`, import `AGENT_VERSION_HEADER` from `@mc/protocol` and `VERSION` from `../version`, then send the header in `request`:

```ts
      headers: {
        Authorization: `Bearer ${c.secret}`,
        [AGENT_VERSION_HEADER]: VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
```

In `apps/agent/src/cli.ts`:
- add `| { kind: "version" }` to the `Command` union;
- add `version: { type: "boolean", default: false },` to the `parseArgs` options;
- right after `const [group, sub, a, b, c] = positionals;`, add
  `if (values.version || group === "version") return { kind: "version" };` before the help check;
- add to `USAGE` under Hosting:
  ```
    version
        Print mc-host's version.
  ```

In `apps/agent/src/commands.ts`, import `VERSION` from `./version` and add a case to `runCommand`:

```ts
    case "version":
      deps.log(`mc-host ${VERSION}`);
      return;
```

- [ ] **Step 9: Run the agent tests and the typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/protocol apps/worker apps/agent tsconfig.json
git commit -m "feat: agents send their version and the Worker turns away outdated ones"
```

---

### Task 2: Tailscale API client

**Files:**
- Create: `apps/worker/src/tailscale.ts`
- Create: `apps/worker/test/tailscale.ts` (fake, shared by later tasks)
- Create: `apps/worker/test/tailscale.vitest.ts`
- Modify: `apps/worker/src/env.ts`, `apps/worker/vitest.config.ts`, `apps/worker/test/helpers.ts`

**Interfaces:**
- Produces: `PLAYER_TAG = "tag:mc-player"`, `AUTH_KEY_SECONDS = 600`, `class TailscaleError extends Error`, `mintAuthKey(env: Creds, description: string): Promise<string>`, `deleteDevice(env: Creds, nodeId: string): Promise<void>` (404 counts as success), where `Creds = Pick<Env, "TS_OAUTH_CLIENT_ID" | "TS_OAUTH_CLIENT_SECRET">`.
- Produces (tests): `fakeTailscale(o?: { mint?: "fail"; deleteStatus?: Record<string, number> }): TsCall[]` in `test/tailscale.ts`, where `TsCall = { url: string; method: string; auth: string | null; body: any }`. The fake returns key `"tskey-auth-test"` and access token `"ts-access"`.

- [ ] **Step 1: Env and test bindings**

Add to `Env` in `apps/worker/src/env.ts`:

```ts
  /** OAuth client on the Minecraft tailnet (scopes: auth_keys, devices:core; tag:mc-player). */
  TS_OAUTH_CLIENT_ID: string;
  TS_OAUTH_CLIENT_SECRET: string;
```

In `apps/worker/vitest.config.ts`, add to `miniflare.bindings`:

```ts
            TS_OAUTH_CLIENT_ID: "ts-client",
            TS_OAUTH_CLIENT_SECRET: "ts-secret",
```

In `apps/worker/test/helpers.ts` `envWith`, add:

```ts
    TS_OAUTH_CLIENT_ID: env.TS_OAUTH_CLIENT_ID,
    TS_OAUTH_CLIENT_SECRET: env.TS_OAUTH_CLIENT_SECRET,
```

- [ ] **Step 2: Write the fake and the failing test**

Create `apps/worker/test/tailscale.ts`:

```ts
import { vi } from "vitest";

export interface TsCall {
  url: string;
  method: string;
  auth: string | null;
  body: any;
}

/**
 * Fake the Tailscale API for the rest of the test and record each call. Pair with
 * afterEach(vi.restoreAllMocks). `deleteStatus` maps a node id to the status its DELETE gets.
 */
export function fakeTailscale(o: { mint?: "fail"; deleteStatus?: Record<string, number> } = {}): TsCall[] {
  const calls: TsCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as Request | string, init);
    const text = await req.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    calls.push({ url: req.url, method: req.method, auth: req.headers.get("Authorization"), body });
    if (req.url.endsWith("/oauth/token")) return Response.json({ access_token: "ts-access", token_type: "Bearer", expires_in: 3600 });
    if (req.url.endsWith("/tailnet/-/keys")) {
      return o.mint === "fail" ? Response.json({ message: "requested tags are invalid" }, { status: 403 }) : Response.json({ id: "k1", key: "tskey-auth-test" });
    }
    const m = /\/device\/([^/]+)$/.exec(req.url);
    if (m && req.method === "DELETE") {
      const status = o.deleteStatus?.[decodeURIComponent(m[1]!)] ?? 200;
      return new Response(status === 200 ? null : JSON.stringify({ message: "nope" }), { status });
    }
    return new Response("unexpected request", { status: 500 });
  });
  return calls;
}
```

Create `apps/worker/test/tailscale.vitest.ts`:

```ts
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteDevice, mintAuthKey, TailscaleError } from "../src/tailscale";
import { fakeTailscale } from "./tailscale";

afterEach(() => vi.restoreAllMocks());

describe("mintAuthKey", () => {
  it("gets an access token with the OAuth client, then asks for a single-use tagged key", async () => {
    const calls = fakeTailscale();
    expect(await mintAuthKey(env, "setup mc-alex")).toBe("tskey-auth-test");
    expect(calls[0]!.url).toBe("https://api.tailscale.com/api/v2/oauth/token");
    expect(calls[0]!.body).toBe("client_id=ts-client&client_secret=ts-secret");
    expect(calls[1]).toEqual({
      url: "https://api.tailscale.com/api/v2/tailnet/-/keys",
      method: "POST",
      auth: "Bearer ts-access",
      body: {
        description: "setup mc-alex",
        expirySeconds: 600,
        capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: ["tag:mc-player"] } } },
      },
    });
  });

  it("throws TailscaleError with Tailscale's answer when it refuses", async () => {
    fakeTailscale({ mint: "fail" });
    await expect(mintAuthKey(env, "x")).rejects.toThrow(TailscaleError);
    await expect(mintAuthKey(env, "x")).rejects.toThrow(/403.*requested tags are invalid/);
  });

  it("throws TailscaleError when Tailscale can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(mintAuthKey(env, "x")).rejects.toThrow(TailscaleError);
  });
});

describe("deleteDevice", () => {
  it("deletes by node id", async () => {
    const calls = fakeTailscale();
    await deleteDevice(env, "nABC123CNTRL");
    expect(calls[1]).toMatchObject({ url: "https://api.tailscale.com/api/v2/device/nABC123CNTRL", method: "DELETE", auth: "Bearer ts-access" });
  });

  it("counts a device that's already gone as deleted", async () => {
    fakeTailscale({ deleteStatus: { gone: 404 } });
    await expect(deleteDevice(env, "gone")).resolves.toBeUndefined();
  });

  it("throws TailscaleError on other failures", async () => {
    fakeTailscale({ deleteStatus: { broken: 500 } });
    await expect(deleteDevice(env, "broken")).rejects.toThrow(TailscaleError);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd apps/worker && bunx vitest run test/tailscale.vitest.ts`
Expected: FAIL, `Cannot find module '../src/tailscale'`.

- [ ] **Step 4: Implement**

Create `apps/worker/src/tailscale.ts`:

```ts
import type { Env } from "./env";

const API = "https://api.tailscale.com/api/v2";
export const PLAYER_TAG = "tag:mc-player";
export const AUTH_KEY_SECONDS = 600;

/** Tailscale refused or couldn't be reached. The message is for the Worker's logs, not for users. */
export class TailscaleError extends Error {}

type Creds = Pick<Env, "TS_OAUTH_CLIENT_ID" | "TS_OAUTH_CLIENT_SECRET">;

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new TailscaleError(`Couldn't reach Tailscale: ${(err as Error).message}`);
  }
}

async function refused(what: string, res: Response): Promise<TailscaleError> {
  return new TailscaleError(`Tailscale answered ${res.status} to ${what}: ${(await res.text()).slice(0, 300)}`);
}

/** A fresh access token per call; this runs a handful of times a week. */
async function accessToken(env: Creds): Promise<string> {
  const res = await send(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.TS_OAUTH_CLIENT_ID, client_secret: env.TS_OAUTH_CLIENT_SECRET }).toString(),
  });
  if (!res.ok) throw await refused("the token request", res);
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) throw new TailscaleError("Tailscale's token reply had no access_token.");
  return access_token;
}

/** A single-use, pre-authorized auth key that tags the device tag:mc-player. */
export async function mintAuthKey(env: Creds, description: string): Promise<string> {
  const token = await accessToken(env);
  const res = await send(`${API}/tailnet/-/keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      description,
      expirySeconds: AUTH_KEY_SECONDS,
      capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [PLAYER_TAG] } } },
    }),
  });
  if (!res.ok) throw await refused("an auth key request", res);
  const { key } = (await res.json()) as { key?: string };
  if (!key) throw new TailscaleError("Tailscale's auth key reply had no key.");
  return key;
}

/** Remove a device from the tailnet. One that's already gone counts as removed. */
export async function deleteDevice(env: Creds, nodeId: string): Promise<void> {
  const token = await accessToken(env);
  const res = await send(`${API}/device/${encodeURIComponent(nodeId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (res.ok || res.status === 404) return;
  throw await refused(`deleting device ${nodeId}`, res);
}
```

Keep the auth key `description` within Tailscale's limit of 50 characters (letters, digits, hyphens, spaces). Task 4 passes `setup <hostname>`, which is at most 46.

- [ ] **Step 5: Run the tests**

Run: `cd apps/worker && bunx vitest run && bunx tsc -p .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): Tailscale client for tagged auth keys and device removal"
```

---

### Task 3: Enrollment codes and `/setup`

**Files:**
- Create: `apps/worker/migrations/0002_onboarding.sql`
- Create: `apps/worker/src/enroll.ts`
- Modify: `apps/worker/src/users.ts`
- Create: `apps/worker/src/commands/setup.ts`
- Modify: `apps/worker/src/commands/index.ts`, `apps/worker/src/commands/help.ts`
- Modify: `apps/worker/src/discord/registry.ts`, `apps/worker/src/discord/router.ts`
- Modify: `apps/worker/test/discord.ts`, `apps/worker/test/definitions.vitest.ts`
- Create: `apps/worker/test/setup.vitest.ts`

**Interfaces:**
- Consumes: `hashToken` from `src/auth.ts`.
- Produces in `src/enroll.ts`: `type Mode = "play" | "host"`, `interface EnrollmentRow { discord_id: string; name: string; code_hash: string; mode: Mode; created_at: number; expires_at: number; used_at: number | null }`, `CODE_MS`, `DEVICE_WINDOW_MS`, `newCode(): string`, `normalizeCode(raw: string): string | null`, `createEnrollment(db, { discordId, name, mode, now }): Promise<string>`, `pendingEnrollment(db, rawCode, now): Promise<EnrollmentRow | null>`, `consumeEnrollment(db, row, now): Promise<boolean>`, `recentlyUsedEnrollment(db, rawCode, now): Promise<EnrollmentRow | null>`, `tailnetHostname(name: string, discordId: string): string`.
- Produces in `src/users.ts`: `isRevoked(db, discordId): Promise<boolean>`, `ensurePlayer(db, discordId, name, now): Promise<void>`, `revokeUser(db, discordId, now): Promise<void>`.
- Produces: `Invocation.userName: string` (the Discord username). `REVOKED` and `setupMessage(origin, code, mode)` in `src/commands/setup.ts`. `test/discord.ts` `Who` gains `username?: string`.

- [ ] **Step 1: Migration**

Create `apps/worker/migrations/0002_onboarding.sql`:

```sql
-- One pending /setup code per person. Only the code's sha256 is stored.
CREATE TABLE enrollments (
  discord_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('play', 'host')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Set when the installer redeems the code; /enroll/device accepts it for 15 minutes after.
  used_at INTEGER
);

-- Tailnet devices the installer reported, so /tailnet revoke deletes exactly these.
CREATE TABLE devices (
  node_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX devices_by_user ON devices (discord_id);
```

- [ ] **Step 2: Write the failing tests**

In `apps/worker/test/discord.ts`, let tests choose the username:

```ts
type Who = { user?: string; username?: string; maintainer?: boolean; noMember?: boolean };
…
function base(type: number, who: Who) {
  const user = { id: who.user ?? ALEX, username: who.username ?? "someone" };
```

In `apps/worker/test/definitions.vitest.ts`, update the expected names:

```ts
    expect(cmds.map((c) => c.name).sort()).toEqual(["help", "host", "join", "mod", "modpack", "setup", "status", "world"]);
```

Create `apps/worker/test/setup.vitest.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CODE_MS, newCode, normalizeCode, pendingEnrollment } from "../src/enroll";
import { revokeUser } from "../src/users";
import { ALEX, postInteraction, slash } from "./discord";

const CODE = /\/s\/([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/;
const row = () => env.DB.prepare("SELECT * FROM enrollments WHERE discord_id = ?").bind(ALEX).first<any>();

async function runSetup(options: Record<string, boolean> = {}) {
  const r = await postInteraction(slash("setup", options, { username: "alex.v" }));
  const content: string = r.body.data.content;
  return { content, code: CODE.exec(content)?.[1] ?? null, flags: r.body.data.flags };
}

describe("codes", () => {
  it("are 8 characters from the unambiguous alphabet, shown as XXXX-XXXX", () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });

  it("are read back however they were pasted", () => {
    expect(normalizeCode("k7qx-p2md")).toBe("K7QX-P2MD");
    expect(normalizeCode(" K7QXP2MD ")).toBe("K7QX-P2MD");
    expect(normalizeCode("k7qx p2md")).toBe("K7QX-P2MD");
  });

  it("reject anything that can't be a code", () => {
    expect(normalizeCode("K7QX-P2M")).toBeNull();
    expect(normalizeCode("K7QX-P2M0")).toBeNull(); // 0 isn't in the alphabet
    expect(normalizeCode("")).toBeNull();
  });
});

describe("/setup", () => {
  it("replies privately with a personal one-liner and stores only the code's hash", async () => {
    const { content, code, flags } = await runSetup();
    expect(flags).toBe(64); // ephemeral
    expect(content).toContain(`irm http://localhost/s/${code} | iex`);
    expect(content).toContain("works once and expires in 15 minutes");
    const r = await row();
    expect(r).toMatchObject({ name: "alex.v", mode: "play", used_at: null });
    expect(r.code_hash).not.toContain(code);
    expect(r.expires_at - r.created_at).toBe(CODE_MS);
  });

  it("host:True makes a hosting code", async () => {
    const { content } = await runSetup({ host: true });
    expect(content).toContain("play and host");
    expect((await row()).mode).toBe("host");
  });

  it("a second /setup replaces the first code", async () => {
    const first = (await runSetup()).code!;
    const second = (await runSetup()).code!;
    expect(await pendingEnrollment(env.DB, first, Date.now())).toBeNull();
    expect(await pendingEnrollment(env.DB, second, Date.now())).not.toBeNull();
  });

  it("refuses someone who was removed", async () => {
    await revokeUser(env.DB, ALEX, Date.now());
    const { content, code } = await runSetup();
    expect(content).toBe("You've been removed from the Minecraft network. Ask a maintainer to let you back in.");
    expect(code).toBeNull();
    expect(await row()).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd apps/worker && bunx vitest run test/setup.vitest.ts test/definitions.vitest.ts`
Expected: FAIL, `Cannot find module '../src/enroll'`.

- [ ] **Step 4: Implement `src/enroll.ts`**

```ts
import { hashToken } from "./auth";

export const CODE_MS = 15 * 60_000;
export const DEVICE_WINDOW_MS = 15 * 60_000;
/** 32 characters: digits and capitals without 0/O and 1/I, so a code survives being read aloud. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type Mode = "play" | "host";

export interface EnrollmentRow {
  discord_id: string;
  name: string;
  code_hash: string;
  mode: Mode;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

const dash = (s: string) => `${s.slice(0, 4)}-${s.slice(4)}`;

export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return dash([...bytes].map((b) => ALPHABET[b & 31]).join(""));
}

/** "k7qx p2md", "K7QXP2MD" … → "K7QX-P2MD"; null if it can't be a code. */
export function normalizeCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length !== 8 || [...s].some((ch) => !ALPHABET.includes(ch))) return null;
  return dash(s);
}

/** Store a new code for this person, replacing any code they had, and return it. */
export async function createEnrollment(db: D1Database, o: { discordId: string; name: string; mode: Mode; now: number }): Promise<string> {
  const code = newCode();
  await db
    .prepare(
      `INSERT INTO enrollments (discord_id, name, code_hash, mode, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (discord_id) DO UPDATE SET name = excluded.name, code_hash = excluded.code_hash, mode = excluded.mode,
         created_at = excluded.created_at, expires_at = excluded.expires_at, used_at = NULL`,
    )
    .bind(o.discordId, o.name, await hashToken(code), o.mode, o.now, o.now + CODE_MS)
    .run();
  return code;
}

async function byCode(db: D1Database, raw: string): Promise<EnrollmentRow | null> {
  const code = normalizeCode(raw);
  if (!code) return null;
  return db.prepare("SELECT * FROM enrollments WHERE code_hash = ?").bind(await hashToken(code)).first<EnrollmentRow>();
}

/** A code that hasn't been used and hasn't expired. */
export async function pendingEnrollment(db: D1Database, raw: string, now: number): Promise<EnrollmentRow | null> {
  const row = await byCode(db, raw);
  return row && row.used_at === null && row.expires_at > now ? row : null;
}

/** Mark the code used. False if another redemption got there first or it expired meanwhile. */
export async function consumeEnrollment(db: D1Database, row: EnrollmentRow, now: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE enrollments SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1")
    .bind(now, row.code_hash)
    .run();
  return r.meta.changes === 1;
}

/** A code used within DEVICE_WINDOW_MS, for the installer's device report. */
export async function recentlyUsedEnrollment(db: D1Database, raw: string, now: number): Promise<EnrollmentRow | null> {
  const row = await byCode(db, raw);
  return row && row.used_at !== null && now - row.used_at <= DEVICE_WINDOW_MS ? row : null;
}

/** "mc-" + the username in [a-z0-9-], at most 40 characters in all. */
export function tailnetHostname(name: string, discordId: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 37)
    .replace(/-$/, "");
  return `mc-${s || `player-${discordId.slice(-4)}`}`;
}
```

- [ ] **Step 5: Add to `src/users.ts`**

```ts
/** Someone who only plays still gets a row, so revoking works the same for everyone. Its token is never shown, so it can't host. */
export async function ensurePlayer(db: D1Database, discordId: string, name: string, now: number): Promise<void> {
  await db
    .prepare("INSERT INTO users (discord_id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (discord_id) DO NOTHING")
    .bind(discordId, name, await hashToken(randomToken()), now)
    .run();
}

/** Block their token and future /setup. `mc-host admin token mint` clears it again. */
export async function revokeUser(db: D1Database, discordId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (discord_id, name, token_hash, created_at, revoked_at) VALUES (?1, '(never set up)', ?2, ?3, ?3)
       ON CONFLICT (discord_id) DO UPDATE SET revoked_at = excluded.revoked_at`,
    )
    .bind(discordId, await hashToken(randomToken()), now)
    .run();
}

export async function isRevoked(db: D1Database, discordId: string): Promise<boolean> {
  const row = await db.prepare("SELECT revoked_at FROM users WHERE discord_id = ?").bind(discordId).first<{ revoked_at: number | null }>();
  return !!row && row.revoked_at !== null;
}
```

- [ ] **Step 6: Username on the invocation**

In `src/discord/registry.ts`, add to `Invocation`:

```ts
  userId: string;
  /** Discord username (not the display name); used for tailnet hostnames. */
  userName: string;
```

In `src/discord/router.ts`, next to `userId`:

```ts
    userId: i.member?.user.id ?? i.user?.id ?? "",
    userName: i.member?.user.username ?? i.user?.username ?? "",
```

- [ ] **Step 7: The `/setup` command**

Create `apps/worker/src/commands/setup.ts`:

```ts
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { createEnrollment, type Mode } from "../enroll";
import { isRevoked } from "../users";

export const REVOKED = "You've been removed from the Minecraft network. Ask a maintainer to let you back in.";

export function setupMessage(origin: string, code: string, mode: Mode): string {
  return [
    mode === "host" ? "**Set up this PC to play and host** (Windows)" : "**Join the Minecraft network** (Windows)",
    "1. Open PowerShell: Start → type **PowerShell** → Enter.",
    "2. Paste this line and press Enter:",
    "```",
    `irm ${origin}/s/${code} | iex`,
    "```",
    "3. Click **Yes** when Windows asks for permission.",
    "",
    "This line is just for you. It works once and expires in 15 minutes.",
    ...(mode === "play" ? ["To host the world too, run `/setup` with `host` set to True."] : []),
  ].join("\n");
}

export const setup: Command = {
  path: "setup",
  description: "Get a one-line installer that puts your Windows PC on the Minecraft network",
  maintainerOnly: false,
  options: [
    { type: ApplicationCommandOptionType.Boolean, name: "host", description: "Also install mc-host so you can host the world", required: false },
  ],
  async run(c) {
    if (await isRevoked(c.env.DB, c.userId)) return reply(REVOKED);
    const mode: Mode = c.options.host === true ? "host" : "play";
    const code = await createEnrollment(c.env.DB, { discordId: c.userId, name: c.userName, mode, now: c.now });
    return reply(setupMessage(c.origin, code, mode));
  },
};
```

Register it in `src/commands/index.ts`: import `setup` and put it after `help` in `commands`.

In `src/commands/help.ts`, change the last line so it still mentions `mc-host start`:

```ts
    return reply([
      "**Minecraft bot commands**",
      ...lines,
      "",
      "New here? Run `/setup`. To host, run `/setup` with `host` set to True once, then `mc-host start` (or **Host Minecraft** in the Start Menu).",
    ].join("\n"));
```

- [ ] **Step 8: Run the Worker tests**

Run: `cd apps/worker && bunx vitest run && bunx tsc -p .`
Expected: PASS. If a router test builds an `Invocation` by hand, add `userName: "someone"` to it.

- [ ] **Step 9: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): /setup hands out a single-use enrollment code"
```

---

### Task 4: Enrollment routes (`/s/:code`, `/enroll`, `/enroll/device`)

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Create: `scripts/install.ps1` (header only here; Task 7 writes the body)
- Create: `apps/worker/src/text-modules.d.ts`
- Modify: `apps/worker/wrangler.jsonc`
- Create: `apps/worker/src/routes/enroll.ts`
- Modify: `apps/worker/src/index.ts`
- Create: `apps/worker/test/enroll.vitest.ts`

**Interfaces:**
- Consumes: Task 2 (`mintAuthKey`, `TailscaleError`) and Task 3 (`pendingEnrollment`, `consumeEnrollment`, `recentlyUsedEnrollment`, `normalizeCode`, `tailnetHostname`, `ensurePlayer`), plus `mintToken` from `src/users.ts`.
- Produces: `EnrollRequestSchema` (`{ code: string; join: boolean }`), `EnrollResponseSchema` (`{ hostname: string; authKey?: string; token?: string }`), `EnrollDeviceRequestSchema` (`{ code: string; nodeId: string }`) in `@mc/protocol`. `installScript(origin, code, mode)` and `expiredScript()` in `src/routes/enroll.ts`. The script placeholders are the exact strings `'__WORKER_URL__'`, `'__CODE__'` and `'__MODE__'` (quotes included), each appearing once in `scripts/install.ps1`.

- [ ] **Step 1: Protocol schemas**

Append to `packages/protocol/src/index.ts`:

```ts
const EnrollCode = z.string().min(1).max(32);
export const EnrollRequestSchema = z.object({ code: EnrollCode, join: z.boolean() });
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;
export const EnrollResponseSchema = z.object({ hostname: z.string(), authKey: z.string().optional(), token: z.string().optional() });
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;
/** nodeId is `Self.ID` from `tailscale status --json`, e.g. "nABC123CNTRL". */
export const EnrollDeviceRequestSchema = z.object({ code: EnrollCode, nodeId: z.string().regex(/^[A-Za-z0-9]{1,64}$/) });
export type EnrollDeviceRequest = z.infer<typeof EnrollDeviceRequestSchema>;
```

- [ ] **Step 2: Script header and the text import**

Create `scripts/install.ps1` with just its header for now (Task 7 fills in the rest):

```powershell
# Minecraft network setup for Windows. The Worker serves this at /s/<code> with the three
# values below filled in; people run it as:  irm <worker>/s/<code> | iex
# It runs inside the person's own PowerShell window, so it never calls `exit` (that would
# close their window): everything is in one script block that returns or throws instead.
& {
$WorkerUrl = '__WORKER_URL__'
$Code = '__CODE__'
$Mode = '__MODE__'
Write-Host "Setup for $Mode on $WorkerUrl"
}
```

In `apps/worker/wrangler.jsonc`, after `"main"`, add:

```jsonc
	// scripts/install.ps1 is bundled as a string and served at /s/<code>.
	"rules": [{ "type": "Text", "globs": ["**/*.ps1"], "fallthrough": true }],
```

Create `apps/worker/src/text-modules.d.ts`:

```ts
/** Bundled as text by the "rules" entry in wrangler.jsonc. */
declare module "*.ps1" {
  const text: string;
  export default text;
}
```

(Verified during planning: both Vitest with the Workers pool and `wrangler deploy --dry-run` import a `.ps1` as text with this rule.)

- [ ] **Step 3: Write the failing tests**

Create `apps/worker/test/enroll.vitest.ts`:

```ts
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tailnetHostname } from "../src/enroll";
import { ALEX, postInteraction, slash } from "./discord";
import { call } from "./helpers";
import { fakeTailscale } from "./tailscale";

afterEach(() => vi.restoreAllMocks());

const EXPIRED = { error: "expired", message: "This setup link expired. Run /setup in Discord again." };

async function setupCode(o: Record<string, boolean> = {}, username = "Alex.V_T"): Promise<string> {
  const r = await postInteraction(slash("setup", o, { username }));
  return /\/s\/([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(r.body.data.content)![1]!;
}
const user = () => env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(ALEX).first<any>();
const devices = () => env.DB.prepare("SELECT node_id, discord_id, hostname FROM devices").all().then((r) => r.results);

describe("tailnetHostname", () => {
  it("keeps letters, digits and dashes", () => {
    expect(tailnetHostname("Alex.V_T", "100000000000000001")).toBe("mc-alex-v-t");
  });
  it("falls back to the id when nothing is left", () => {
    expect(tailnetHostname("🎮", "100000000000000042")).toBe("mc-player-0042");
  });
  it("stays within 40 characters and never ends in a dash", () => {
    const h = tailnetHostname(`${"a".repeat(36)}_b${"c".repeat(30)}`, "1");
    expect(h.length).toBeLessThanOrEqual(40);
    expect(h).not.toMatch(/-$/);
  });
});

describe("GET /s/:code", () => {
  it("serves the installer with this Worker's URL, the code and the mode filled in", async () => {
    const code = await setupCode({ host: true });
    const r = await call("GET", `/s/${code}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("$WorkerUrl = 'http://localhost'");
    expect(r.body).toContain(`$Code = '${code}'`);
    expect(r.body).toContain("$Mode = 'host'");
    expect(r.body).not.toContain("__");
  });

  it("serving it doesn't use the code up", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("GET", `/s/${code}`);
    expect((await call("POST", "/enroll", { body: { code, join: true } })).status).toBe(200);
  });

  it("serves a script that just prints the expired message for a bad code", async () => {
    const r = await call("GET", "/s/AAAA-AAAA");
    expect(r.status).toBe(200);
    expect(r.body).toBe("Write-Host 'This setup link expired. Run /setup in Discord again.' -ForegroundColor Yellow\n");
  });
});

describe("POST /enroll", () => {
  it("play: mints a network key but no hosting token, and records the player", async () => {
    const calls = fakeTailscale();
    const code = await setupCode();
    const r = await call("POST", "/enroll", { body: { code, join: true } });
    expect(r).toEqual({ status: 200, body: { hostname: "mc-alex-v-t", authKey: "tskey-auth-test" } });
    expect(calls[1]!.body.description).toBe("setup mc-alex-v-t");
    expect(await user()).toMatchObject({ name: "Alex.V_T", revoked_at: null });
  });

  it("host: also returns a hosting token that works", async () => {
    fakeTailscale();
    const code = await setupCode({ host: true });
    const r = await call("POST", "/enroll", { body: { code, join: true } });
    expect(r.body.token).toEqual(expect.any(String));
    const manifest = await call("GET", "/agent/manifest", { token: r.body.token });
    expect(manifest.body.error).toBe("no_active_world"); // past the token check
  });

  it("join:false mints no key (the PC is already on the network)", async () => {
    const calls = fakeTailscale();
    const code = await setupCode({ host: true });
    const r = await call("POST", "/enroll", { body: { code, join: false } });
    expect(r.body.authKey).toBeUndefined();
    expect(r.body.token).toEqual(expect.any(String));
    expect(calls).toEqual([]);
  });

  it("works once", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    expect(await call("POST", "/enroll", { body: { code, join: true } })).toEqual({ status: 410, body: EXPIRED });
  });

  it("only one of two simultaneous redemptions wins", async () => {
    fakeTailscale();
    const code = await setupCode();
    const results = await Promise.all([1, 2].map(() => call("POST", "/enroll", { body: { code, join: true } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  it("accepts the code however it was typed", async () => {
    fakeTailscale();
    const code = await setupCode();
    expect((await call("POST", "/enroll", { body: { code: ` ${code.toLowerCase().replace("-", "")} `, join: true } })).status).toBe(200);
  });

  it("refuses an expired code", async () => {
    fakeTailscale();
    const code = await setupCode();
    await env.DB.prepare("UPDATE enrollments SET expires_at = ?").bind(Date.now() - 1).run();
    expect(await call("POST", "/enroll", { body: { code, join: true } })).toEqual({ status: 410, body: EXPIRED });
  });

  it("leaves the code usable when Tailscale refuses to make a key", async () => {
    fakeTailscale({ mint: "fail" });
    const code = await setupCode();
    const r = await call("POST", "/enroll", { body: { code, join: true } });
    expect(r).toEqual({
      status: 502,
      body: { error: "upstream", message: "Couldn't create your network key. Try again in a minute. If it keeps failing, tell a maintainer." },
    });
    vi.restoreAllMocks();
    fakeTailscale();
    expect((await call("POST", "/enroll", { body: { code, join: true } })).status).toBe(200);
  });
});

describe("POST /enroll/device", () => {
  it("records the device after the code was used", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "nABC123CNTRL" } })).body).toEqual({ ok: true });
    expect(await devices()).toEqual([{ node_id: "nABC123CNTRL", discord_id: ALEX, hostname: "mc-alex-v-t" }]);
  });

  it("refuses a code that hasn't been redeemed", async () => {
    const code = await setupCode();
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "n1" } })).status).toBe(410);
  });

  it("refuses once the 15-minute window has passed", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    await env.DB.prepare("UPDATE enrollments SET used_at = ?").bind(Date.now() - 16 * 60_000).run();
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "n1" } })).status).toBe(410);
    expect(await devices()).toEqual([]);
  });

  it("rejects a node id that isn't one", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "n1; DROP" } })).status).toBe(400);
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `cd apps/worker && bunx vitest run test/enroll.vitest.ts`
Expected: the `tailnetHostname` tests PASS, the rest FAIL with 404 ("There's nothing at this address.").

- [ ] **Step 5: Implement the routes**

Create `apps/worker/src/routes/enroll.ts`:

```ts
import { EnrollDeviceRequestSchema, EnrollRequestSchema, type EnrollResponse, type Ok } from "@mc/protocol";
import { Hono } from "hono";
import script from "../../../../scripts/install.ps1";
import { consumeEnrollment, normalizeCode, pendingEnrollment, recentlyUsedEnrollment, tailnetHostname, type Mode } from "../enroll";
import type { AppEnv } from "../env";
import { ApiError, readBody } from "../errors";
import { mintAuthKey, TailscaleError } from "../tailscale";
import { ensurePlayer, mintToken } from "../users";

export const EXPIRED = "This setup link expired. Run /setup in Discord again.";
export const NO_KEY = "Couldn't create your network key. Try again in a minute. If it keeps failing, tell a maintainer.";

/** A PowerShell single-quoted string literal. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function installScript(origin: string, code: string, mode: Mode): string {
  return script.replace("'__WORKER_URL__'", psQuote(origin)).replace("'__CODE__'", psQuote(code)).replace("'__MODE__'", psQuote(mode));
}

export const expiredScript = (): string => `Write-Host ${psQuote(EXPIRED)} -ForegroundColor Yellow\n`;

/** GET /s/:code: always 200, because `irm` would print a red error for anything else. */
export const setupScript = new Hono<AppEnv>();
setupScript.get("/:code", async (c) => {
  const raw = c.req.param("code");
  const row = await pendingEnrollment(c.env.DB, raw, Date.now());
  const body = row ? installScript(new URL(c.req.url).origin, normalizeCode(raw)!, row.mode) : expiredScript();
  return c.text(body, 200, { "Cache-Control": "no-store" });
});

export const enroll = new Hono<AppEnv>();

enroll.post("/", async (c) => {
  const req = await readBody(c, EnrollRequestSchema);
  const now = Date.now();
  const row = await pendingEnrollment(c.env.DB, req.code, now);
  if (!row) throw new ApiError("expired", EXPIRED);
  const hostname = tailnetHostname(row.name, row.discord_id);
  // Mint before using the code up, so a Tailscale hiccup leaves the same line usable.
  let authKey: string | undefined;
  if (req.join) {
    try {
      authKey = await mintAuthKey(c.env, `setup ${hostname}`);
    } catch (err) {
      if (!(err instanceof TailscaleError)) throw err;
      console.error(err.message);
      throw new ApiError("upstream", NO_KEY);
    }
  }
  // Losing this race wastes the key, which is single-use and expires in 10 minutes anyway.
  if (!(await consumeEnrollment(c.env.DB, row, now))) throw new ApiError("expired", EXPIRED);
  let token: string | undefined;
  if (row.mode === "host") token = await mintToken(c.env.DB, row.discord_id, row.name, now);
  else await ensurePlayer(c.env.DB, row.discord_id, row.name, now);
  const body: EnrollResponse = { hostname, ...(authKey ? { authKey } : {}), ...(token ? { token } : {}) };
  return c.json(body);
});

enroll.post("/device", async (c) => {
  const req = await readBody(c, EnrollDeviceRequestSchema);
  const now = Date.now();
  const row = await recentlyUsedEnrollment(c.env.DB, req.code, now);
  if (!row) throw new ApiError("expired", EXPIRED);
  await c.env.DB.prepare(
    `INSERT INTO devices (node_id, discord_id, hostname, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (node_id) DO UPDATE SET discord_id = excluded.discord_id, hostname = excluded.hostname`,
  )
    .bind(req.nodeId, row.discord_id, tailnetHostname(row.name, row.discord_id), now)
    .run();
  const body: Ok = { ok: true };
  return c.json(body);
});
```

In `apps/worker/src/index.ts`, mount both routers (import from `./routes/enroll`) and delete the stale `// routers: mounted by later tasks` comment:

```ts
app.route("/modpack", modpack);
app.route("/s", setupScript);
app.route("/enroll", enroll);
```

- [ ] **Step 6: Run the Worker tests**

Run: `cd apps/worker && bunx vitest run && bunx tsc -p .`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol apps/worker scripts/install.ps1
git commit -m "feat(worker): serve the installer and redeem setup codes for network keys and tokens"
```

---

### Task 5: `/tailnet revoke`

**Files:**
- Create: `apps/worker/src/commands/tailnet-revoke.ts`
- Modify: `apps/worker/src/commands/index.ts`
- Modify: `apps/worker/test/definitions.vitest.ts`
- Create: `apps/worker/test/tailnet-revoke.vitest.ts`

**Interfaces:**
- Consumes: `deleteDevice` and `TailscaleError` (Task 2), `revokeUser` (Task 3), `confirmRow` and `mention` (existing), `readLease`/`isHeld`/`LEASE_MS` from `src/lease.ts`, `STALE` from `src/discord/respond.ts`.
- Produces: the `tailnetRevoke` command (path `"tailnet revoke"`, option `user`) and `revokeAction` (name `"revoke"`, args `[discordId]`). Registry group `tailnet: "The Minecraft network"`.

- [ ] **Step 1: Write the failing tests**

In `apps/worker/test/definitions.vitest.ts`:

```ts
    expect(cmds.map((c) => c.name).sort()).toEqual(["help", "host", "join", "mod", "modpack", "setup", "status", "tailnet", "world"]);
```

and in the "hides a command only when…" test add:

```ts
    expect(byName.tailnet!.default_member_permissions).toBe("0");
```

Create `apps/worker/test/tailnet-revoke.vitest.ts`:

```ts
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALEX, button, postInteraction, SAM, slash } from "./discord";
import { addWorld, call, hostSince } from "./helpers";
import { fakeTailscale } from "./tailscale";

afterEach(() => vi.restoreAllMocks());

const M = { maintainer: true, user: SAM };
const confirmId = (r: { body: any }) => r.body.data.components[0].components[0].custom_id as string;

/** ALEX goes through /setup host and the installer, reporting the given devices. */
async function enrolled(nodeIds: string[]): Promise<string> {
  fakeTailscale();
  let token = "";
  for (const nodeId of nodeIds) {
    const r = await postInteraction(slash("setup", { host: true }, { username: "alex" }));
    const code = /\/s\/([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(r.body.data.content)![1]!;
    token = (await call("POST", "/enroll", { body: { code, join: true } })).body.token;
    await call("POST", "/enroll/device", { body: { code, nodeId } });
  }
  vi.restoreAllMocks();
  return token;
}
const count = (table: string) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE discord_id = ?`).bind(ALEX).first<number>("n");

describe("/tailnet revoke", () => {
  it("previews the devices it will remove", async () => {
    await enrolled(["nOne", "nTwo"]);
    const r = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    expect(r.body.data.content).toContain(`Remove <@${ALEX}> from the Minecraft network?`);
    expect(r.body.data.content).toContain("their 2 devices (`mc-alex`, `mc-alex`)");
    expect(confirmId(r)).toBe(`c:revoke:${ALEX}`);
  });

  it("Confirm deletes the devices, blocks the token and refuses /setup", async () => {
    const token = await enrolled(["nOne"]);
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    const calls = fakeTailscale();
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain(`Removed <@${ALEX}> from the Minecraft network`);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://api.tailscale.com/api/v2/device/nOne"]);
    expect(await count("devices")).toBe(0);
    expect(await count("enrollments")).toBe(0);
    expect((await call("GET", "/agent/manifest", { token })).status).toBe(401);
    const again = await postInteraction(slash("setup", {}, { username: "alex" }));
    expect(again.body.data.content).toContain("You've been removed from the Minecraft network");
  });

  it("counts a device Tailscale already forgot as removed", async () => {
    await enrolled(["nGone"]);
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    fakeTailscale({ deleteStatus: { nGone: 404 } });
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain("Removed");
    expect(await count("devices")).toBe(0);
  });

  it("still blocks them when Tailscale fails, and says to run it again", async () => {
    const token = await enrolled(["nStuck"]);
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    fakeTailscale({ deleteStatus: { nStuck: 500 } });
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain("couldn't reach Tailscale to remove `mc-alex`");
    expect(done.body.data.content).toContain("Run `/tailnet revoke` again");
    expect(await count("devices")).toBe(1);
    expect((await call("GET", "/agent/manifest", { token })).status).toBe(401);
  });

  it("blocks someone who never ran /setup", async () => {
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    expect(preview.body.data.content).toContain("no devices on record");
    fakeTailscale();
    await postInteraction(button(confirmId(preview), M));
    const setup = await postInteraction(slash("setup", {}, { username: "alex" }));
    expect(setup.body.data.content).toContain("You've been removed from the Minecraft network");
  });

  it("warns when they're hosting right now", async () => {
    await enrolled(["nOne"]);
    await addWorld("w1");
    await hostSince(ALEX, "w1", 60_000);
    const r = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    expect(r.body.data.content).toContain("They're hosting right now");
  });

  it("needs the maintainer role", async () => {
    const r = await postInteraction(slash("tailnet revoke", { user: ALEX }, { user: SAM }));
    expect(r.body.data.content).toBe("That needs the MC Maintainer role.");
  });

  it("a fresh token lets them back in", async () => {
    await enrolled(["nOne"]);
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    fakeTailscale();
    await postInteraction(button(confirmId(preview), M));
    await call("POST", "/admin/tokens", { admin: true, body: { discordId: ALEX, name: "Alex" } });
    const setup = await postInteraction(slash("setup", {}, { username: "alex" }));
    expect(setup.body.data.content).toContain("irm ");
  });
});
```

Check that `SAM` is exported from `test/discord.ts` (it is), and that `/admin/tokens` takes `{ discordId, name }` (it does: `MintTokenRequestSchema`).

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/worker && bunx vitest run test/tailnet-revoke.vitest.ts test/definitions.vitest.ts`
Expected: FAIL. "I don't know that command" and the missing `tailnet` group.

- [ ] **Step 3: Implement**

Create `apps/worker/src/commands/tailnet-revoke.ts`:

```ts
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { confirmRow } from "../discord/confirm";
import { mention } from "../discord/format";
import type { Command, ConfirmAction } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { deleteDevice, TailscaleError } from "../tailscale";
import { revokeUser } from "../users";

interface DeviceRow {
  node_id: string;
  hostname: string;
}

const devicesOf = async (db: D1Database, discordId: string) =>
  (await db.prepare("SELECT node_id, hostname FROM devices WHERE discord_id = ? ORDER BY created_at").bind(discordId).all<DeviceRow>()).results;

const HOSTING = "They're hosting right now. Their token stops working at once, and the session ends within 10 minutes, as after a crash.";

export const tailnetRevoke: Command = {
  path: "tailnet revoke",
  description: "Remove someone from the Minecraft network and block their hosting token",
  maintainerOnly: true,
  options: [{ type: ApplicationCommandOptionType.User, name: "user", description: "Who to remove", required: true }],
  async run(c) {
    const id = String(c.options.user ?? "");
    const devices = await devicesOf(c.env.DB, id);
    const lease = await readLease(c.env.DB);
    const hosting = isHeld(lease, c.now) && lease.holder_id === id;
    const what = devices.length
      ? `This deletes ${devices.length === 1 ? "their device" : `their ${devices.length} devices`} (${devices.map((d) => `\`${d.hostname}\``).join(", ")}) from the tailnet and blocks their hosting token.`
      : "They have no devices on record, so this blocks their hosting token and any setup link. Remove stray devices in the Tailscale admin console.";
    return reply(
      [`Remove ${mention(id)} from the Minecraft network?`, what, ...(hosting ? [HOSTING] : [])].join("\n"),
      confirmRow("revoke", [id], "Remove"),
    );
  },
};

export const revokeAction: ConfirmAction = {
  name: "revoke",
  async run(c, [id = ""]) {
    if (!/^\d+$/.test(id)) return update(STALE);
    // Block first: that part can't fail halfway, and a rerun finishes the devices.
    await revokeUser(c.env.DB, id, c.now);
    await c.env.DB.prepare("DELETE FROM enrollments WHERE discord_id = ?").bind(id).run();
    const devices = await devicesOf(c.env.DB, id);
    for (const d of devices) {
      try {
        await deleteDevice(c.env, d.node_id);
      } catch (err) {
        if (!(err instanceof TailscaleError)) throw err;
        console.error(err.message);
        return update(
          `Blocked ${mention(id)}'s hosting token and setup links, but couldn't reach Tailscale to remove \`${d.hostname}\`. Run \`/tailnet revoke\` again in a minute to finish.`,
        );
      }
      await c.env.DB.prepare("DELETE FROM devices WHERE node_id = ?").bind(d.node_id).run();
    }
    const removed = devices.length === 1 ? "1 device" : `${devices.length} devices`;
    return update(
      `Removed ${mention(id)} from the Minecraft network: ${removed} deleted, hosting token blocked. To let them back in, run \`mc-host admin token mint ${id} <name>\`, then they run \`/setup\`.`,
    );
  },
};
```

In `src/commands/index.ts`: import `tailnetRevoke` and `revokeAction`, add `tailnet: "The Minecraft network",` to `groups`, append `tailnetRevoke` to `commands`, and append `revokeAction` to `actions`.

- [ ] **Step 4: Run the Worker tests**

Run: `cd apps/worker && bunx vitest run && bunx tsc -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): /tailnet revoke removes someone's devices and blocks their token"
```

---

### Task 6: Agent on Windows (closed window, BOM in `agent.json`)

**Files:**
- Modify: `apps/agent/src/host/signals.ts`, `apps/agent/src/host/run.ts`, `apps/agent/src/commands.ts`, `apps/agent/src/host/config.ts`
- Test: `apps/agent/test/signals.test.ts`, `apps/agent/test/host-config.test.ts`

**Interfaces:**
- Produces: SIGHUP is a stop signal (exit code 129 when nothing is hooked). 129 counts as a normal Java exit. `readJson` in `host/config.ts` ignores a leading UTF-8 BOM.

- [ ] **Step 1: Write the failing tests**

In `apps/agent/test/signals.test.ts`, extend the loop and the unhooked test:

```ts
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
```

```ts
test("with every handler unhooked, the signal ends the process as usual", async () => {
  expect((await signalFixture("SIGINT", "unhooked")).code).toBe(130);
  expect((await signalFixture("SIGTERM", "unhooked")).code).toBe(143);
  expect((await signalFixture("SIGHUP", "unhooked")).code).toBe(129);
});
```

In `apps/agent/test/host-config.test.ts`, add:

```ts
test("agent.json written by Windows PowerShell with a BOM still loads", async () => {
  const d = dir();
  writeFileSync(join(d, "agent.json"), "﻿" + JSON.stringify({ workerUrl: "https://w.test", token: "t" }));
  expect(await loadHostConfig({}, d)).toEqual({ workerUrl: "https://w.test", token: "t" });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test apps/agent/test/signals.test.ts apps/agent/test/host-config.test.ts`
Expected: FAIL. SIGHUP never reaches the run handler, and the BOM file is reported "is damaged".

- [ ] **Step 3: Implement**

In `apps/agent/src/host/signals.ts`, update the doc comment's first line to "Run `handler` on Ctrl+C / SIGINT / SIGTERM / SIGHUP (a closed console window on Windows)" and add:

```ts
    process.on("SIGINT", dispatch(130));
    process.on("SIGTERM", dispatch(143));
    process.on("SIGHUP", dispatch(129));
```

In `apps/agent/src/host/run.ts`:

```ts
/** 129/130/143: Java stopped by a closed window, Ctrl+C or SIGTERM, which is a normal stop. */
const NORMAL_EXIT = new Set([0, 129, 130, 143]);
```

In `apps/agent/src/commands.ts` `cmdRun`:

```ts
  // 129/130/143: stopped by a closed window, Ctrl+C or a terminate signal, which is a normal stop.
  if (code !== 0 && code !== 129 && code !== 130 && code !== 143) {
```

In `apps/agent/src/host/config.ts` `readJson`:

```ts
    // Windows PowerShell 5.1 writes UTF-8 with a BOM, which JSON.parse rejects.
    return JSON.parse((await readFile(path, "utf8")).replace(/^﻿/, "")) as Record<string, unknown>;
```

- [ ] **Step 4: Run the agent tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): a closed hosting window stops the server, and agent.json may have a BOM"
```

---

### Task 7: `install.ps1`

**Files:**
- Modify: `scripts/install.ps1` (replace the Task 4 header-only version)
- Test: `apps/worker/test/enroll.vitest.ts` (still passes: placeholders unchanged)

**Interfaces:**
- Consumes: `GET /s/:code` fills in `$WorkerUrl`, `$Code`, `$Mode`. `POST /enroll { code, join }` returns `{ hostname, authKey?, token? }`. `POST /enroll/device { code, nodeId }`. Errors are `{ error, message }`. Release asset names come from Global Constraints.

There's no automated test for PowerShell here. The Worker tests pin the placeholders, and the Task 9 checklist runs the script on a clean Windows VM. Keep it straight-line.

- [ ] **Step 1: Write the script**

Replace `scripts/install.ps1` with:

```powershell
# Minecraft network setup for Windows. The Worker serves this at /s/<code> with the three
# values below filled in; people run it as:  irm <worker>/s/<code> | iex
# It runs inside the person's own PowerShell window, so it never calls `exit` (that would
# close their window): everything is in one script block that returns or throws instead.
& {
$WorkerUrl = '__WORKER_URL__'
$Code = '__CODE__'
$Mode = '__MODE__'

$Repo = 'alexvtejeda/minecraft-discord-bot'
$PlayerTag = 'tag:mc-player'
$FirewallName = 'Minecraft (mc-host)'
$TsExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$TsMsi = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is far slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say($text) { Write-Host $text }

# POST JSON to the Worker; on failure, throw the Worker's own plain-English message.
function Api($path, $body) {
  try {
    return Invoke-RestMethod -Method Post -Uri "$WorkerUrl$path" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress)
  } catch {
    $msg = $null
    try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).message } catch {}
    if (-not $msg) { $msg = "Couldn't reach the Minecraft bot ($($_.Exception.Message)). Check your internet connection and run the line again." }
    throw $msg
  }
}

# Windows PowerShell 5.1 turns a native command's redirected stderr into a terminating error
# under 'Stop', so every tailscale.exe call runs with 'Continue'.
function TsStatus {
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Path $TsExe)) { return $null }
  try { return (& $TsExe status --json 2>$null | Out-String | ConvertFrom-Json) } catch { return $null }
}

function OnMinecraftNetwork($st) {
  return [bool]($st -and $st.Self -and $st.Self.Tags -and (@($st.Self.Tags) -contains $PlayerTag))
}

function Main {
  $isHost = $Mode -eq 'host'

  # 1. Preflight
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ([Environment]::OSVersion.Version.Major -lt 10 -or $arch -ne 'AMD64') {
    throw 'This installer needs 64-bit Windows 10 or 11 on an Intel or AMD processor. Ask a maintainer for help.'
  }
  if ($isHost -and (Get-Process mc-host -ErrorAction SilentlyContinue)) {
    throw 'mc-host is running. Stop hosting first (Ctrl+C in its window), then run the line again.'
  }
  $st = TsStatus
  $joined = OnMinecraftNetwork $st
  if ($st -and -not $joined -and @('Running', 'Starting', 'Stopped') -contains $st.BackendState) {
    throw "Tailscale on this PC is signed in to another network. This installer won't change it. Ask a maintainer for help."
  }

  # 2. Admin step: one permission prompt for everything that needs it
  $needTailscale = -not (Test-Path $TsExe)
  $needFirewall = $isHost -and -not (Get-NetFirewallRule -DisplayName "$FirewallName*" -ErrorAction SilentlyContinue)
  if ($needTailscale -or $needFirewall) {
    $msi = ''
    if ($needTailscale) {
      Say 'Downloading Tailscale...'
      $msi = Join-Path $env:TEMP 'tailscale-setup.msi'
      Invoke-WebRequest -UseBasicParsing -Uri $TsMsi -OutFile $msi
    }
    $msiQ = $msi -replace "'", "''"
    $fwQ = $FirewallName -replace "'", "''"
    $admin = @"
`$ErrorActionPreference = 'Stop'
if ('$msiQ' -ne '') {
  `$p = Start-Process msiexec.exe -ArgumentList '/i "$msiQ" /quiet /norestart' -Wait -PassThru
  if (`$p.ExitCode -ne 0 -and `$p.ExitCode -ne 3010) { exit 10 }
}
if ('$needFirewall' -eq 'True') {
  Get-NetFirewallRule -DisplayName '$fwQ*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName '$fwQ (game)' -Direction Inbound -Protocol TCP -LocalPort 25565 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName '$fwQ (voice chat)' -Direction Inbound -Protocol UDP -LocalPort 24454 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null
}
exit 0
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($admin))
    Say 'Windows will ask for permission next. Click Yes.'
    try {
      $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
    } catch {
      throw 'Setup needs you to click Yes on the permission prompt. Run the line again to retry.'
    }
    if ($p.ExitCode -eq 10) { throw "Tailscale didn't install. Restart your PC and run the line again. If it still fails, tell a maintainer." }
    if ($p.ExitCode -ne 0) { throw "The admin step failed (code $($p.ExitCode)). Tell a maintainer." }
    if ($needTailscale) {
      Say 'Waiting for Tailscale to start...'
      for ($i = 0; $i -lt 30 -and -not (TsStatus); $i++) { Start-Sleep -Seconds 1 }
      if (-not (TsStatus)) { throw "Tailscale installed but didn't start. Restart your PC and run the line again." }
    }
  }

  # 3. Redeem (after the install, so the 10-minute network key doesn't expire while it runs)
  Say 'Getting your network key...'
  $r = Api '/enroll' @{ code = $Code; join = (-not $joined) }

  # 4. Join
  if (-not $joined) {
    Say 'Joining the Minecraft network...'
    & { $ErrorActionPreference = 'Continue'; & $TsExe up "--auth-key=$($r.authKey)" "--hostname=$($r.hostname)" | Out-Host }
    $ip = $null
    for ($i = 0; $i -lt 60 -and -not $ip; $i++) {
      $st = TsStatus
      if ($st -and $st.BackendState -eq 'Running' -and $st.Self.TailscaleIPs) { $ip = @($st.Self.TailscaleIPs)[0] } else { Start-Sleep -Seconds 1 }
    }
    if (-not $ip) {
      $status = & { $ErrorActionPreference = 'Continue'; & $TsExe status 2>&1 | Out-String }
      throw "Tailscale didn't connect. Paste the text below into Discord for a maintainer.`n$status"
    }
  }

  # 5. Report this device, so a maintainer can remove it later
  $st = TsStatus
  Api '/enroll/device' @{ code = $Code; nodeId = $st.Self.ID } | Out-Null

  # 6. Hosting
  if ($isHost) {
    $bin = Join-Path $env:LOCALAPPDATA 'mc-host\bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $exe = Join-Path $bin 'mc-host.exe'
    $base = "https://github.com/$Repo/releases/latest/download"
    Say 'Downloading mc-host...'
    $tmp = "$exe.download"
    $sums = "$exe.sums"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/mc-host-windows-x64.exe" -OutFile $tmp
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
    $line = Get-Content $sums | Where-Object { $_ -match '[\s*]mc-host-windows-x64\.exe$' } | Select-Object -First 1
    Remove-Item $sums
    $want = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
    $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if (-not $want -or $got -ne $want) {
      Remove-Item $tmp
      throw "The mc-host download didn't match its checksum. Run /setup host again in a few minutes."
    }
    Move-Item -Force $tmp $exe

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $bin)) {
      [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $bin) | Where-Object { $_ }) -join ';'), 'User')
    }
    $env:Path = "$env:Path;$bin"

    # UTF-8 without a BOM: Set-Content -Encoding UTF8 would add one.
    $cfgDir = Join-Path $env:APPDATA 'mc-host'
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    $json = @{ workerUrl = $WorkerUrl; token = $r.token } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $cfgDir 'agent.json'), $json, (New-Object Text.UTF8Encoding $false))

    $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Host Minecraft.lnk'
    $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $sc.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $sc.Arguments = "/k title Minecraft host - press Ctrl+C to save and stop. Don't close this window. & `"$exe`" start"
    $sc.WorkingDirectory = $bin
    $sc.Description = 'Host the Minecraft world'
    $sc.Save()

    Say ''
    & $exe status | Out-Host
  }

  # 7. Done
  Say ''
  Write-Host "You're on the Minecraft network. Run /join in Discord for the address." -ForegroundColor Green
  if ($isHost) {
    Write-Host 'To host, open Host Minecraft from the Start Menu. Press Ctrl+C in that window to save and stop.' -ForegroundColor Green
  }
  if ($joined -and $st.BackendState -ne 'Running') {
    Write-Host 'Tailscale is installed but not connected. Open Tailscale from the Start Menu and click Connect.' -ForegroundColor Yellow
  }
}

try { Main } catch { Write-Host ''; Write-Host $_.Exception.Message -ForegroundColor Red }
}
```

- [ ] **Step 2: Check the placeholders and the syntax**

Run: `grep -c "'__WORKER_URL__'\|'__CODE__'\|'__MODE__'" scripts/install.ps1`
Expected: `3`. Each placeholder appears once, and nothing else in the script contains `__`.

If `pwsh` is installed (`command -v pwsh`), parse the script without running it:
`pwsh -NoProfile -Command '$null = [System.Management.Automation.Language.Parser]::ParseFile("scripts/install.ps1", [ref]$null, [ref]$e); if ($e) { $e; exit 1 } else { "ok" }'`
Expected: `ok`. If `pwsh` isn't installed, skip this; the Task 9 VM checklist covers it.

- [ ] **Step 3: Run the Worker tests**

Run: `cd apps/worker && bunx vitest run test/enroll.vitest.ts`
Expected: PASS (`$WorkerUrl = 'http://localhost'` etc., no `__` left).

- [ ] **Step 4: Commit**

```bash
git add scripts/install.ps1
git commit -m "feat: install.ps1 joins the tailnet, and in host mode installs mc-host and its shortcut"
```

---

### Task 8: Release pipeline

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `apps/agent/package.json` `version` (Task 1). Produces the release assets named in Global Constraints at `https://github.com/alexvtejeda/minecraft-discord-bot/releases/latest/download/<asset>`.

The workflow runs only the Bun tests and the root typecheck. The Worker's Vitest pool connects to the remote R2 binding in `wrangler.jsonc` and needs Cloudflare credentials, and the Worker isn't part of the binary anyway. `bun run deploy` still runs the Worker tests locally.

- [ ] **Step 1: Write the workflow**

```yaml
# Builds prebuilt mc-host binaries when a v* tag is pushed. install.ps1 downloads them from
# releases/latest. The tag must match apps/agent/package.json's version.
name: Release mc-host

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.3
      - run: bun install --frozen-lockfile
      - name: Tag matches the agent version
        run: |
          v=$(bun -e 'console.log(require("./apps/agent/package.json").version)')
          if [ "v$v" != "$GITHUB_REF_NAME" ]; then
            echo "Tag $GITHUB_REF_NAME doesn't match apps/agent/package.json version $v."
            exit 1
          fi
      - run: bunx tsc -p .
      - run: bun test
      - name: Build
        run: |
          mkdir dist
          bun build apps/agent/src/cli.ts --compile --target=bun-windows-x64 --outfile dist/mc-host-windows-x64.exe
          bun build apps/agent/src/cli.ts --compile --target=bun-linux-x64 --outfile dist/mc-host-linux-x64
          cd dist && sha256sum mc-host-windows-x64.exe mc-host-linux-x64 > SHA256SUMS
      - name: Publish
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" dist/mc-host-windows-x64.exe dist/mc-host-linux-x64 dist/SHA256SUMS --title "mc-host $GITHUB_REF_NAME" --generate-notes
```

- [ ] **Step 2: Check the build steps locally**

Run:
```bash
cd /home/noobmaster/minecraft-discord-bot && bunx tsc -p . && bun test \
  && bun build apps/agent/src/cli.ts --compile --target=bun-windows-x64 --outfile /tmp/claude-1000/-home-noobmaster-minecraft-discord-bot/7b036d6c-67b2-47f9-a518-0375df407388/scratchpad/dist/mc-host-windows-x64.exe \
  && bun build apps/agent/src/cli.ts --compile --target=bun-linux-x64 --outfile /tmp/claude-1000/-home-noobmaster-minecraft-discord-bot/7b036d6c-67b2-47f9-a518-0375df407388/scratchpad/dist/mc-host-linux-x64 \
  && /tmp/claude-1000/-home-noobmaster-minecraft-discord-bot/7b036d6c-67b2-47f9-a518-0375df407388/scratchpad/dist/mc-host-linux-x64 --version
```
Expected: tests pass, both builds succeed, and the last line prints `mc-host 0.2.0`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: release prebuilt mc-host binaries on v* tags"
```

(Pushing the tag is part of the Task 9 rollout, not this task.)

---

### Task 9: Setup guide, spec corrections and roadmap

**Files:**
- Create: `docs/setup/phase-4.md`
- Modify: `docs/superpowers/specs/2026-09-26-phase-4-onboarding-design.md`, `ROADMAP.md`

- [ ] **Step 1: Correct the spec to match the plan**

In the spec:
- `%APPDATA%\mc-host\config.json` → `%APPDATA%\mc-host\agent.json` (that's the file the agent already reads).
- Admin step: Tailscale is installed from the official MSI (downloaded before the prompt) instead of winget. The MSI works on every Windows 10/11 and needs no winget.
- `/s/<code>` fills in `$Mode` as well, so the admin step knows before redeeming whether to add the firewall rule.
- `enrollments` has a `name` column (the Discord username, for the hostname and the `users` row).
- The Tailscale client uses the global `fetch`, which tests replace with `vi.spyOn`, as in Phase 3. It doesn't take an injected `fetch`.
- `/tailnet revoke` blocks the token first, then deletes devices. If Tailscale fails partway, the person is already blocked and running the command again finishes the job.
- Agents of 0.1.0 and older don't know the new error codes, so they see "answered HTTP 426" instead of the update message. Only the maintainer's Linux install is affected; re-run `scripts/install.sh`.
- The release workflow runs only the Bun tests and the root typecheck (the Worker tests need Cloudflare credentials).

- [ ] **Step 2: Write `docs/setup/phase-4.md`**

````markdown
# Phase 4: Tailnet onboarding

Design: [../superpowers/specs/2026-09-26-phase-4-onboarding-design.md](../superpowers/specs/2026-09-26-phase-4-onboarding-design.md)

## 1. Tailscale OAuth client

In the Minecraft tailnet's admin console → Settings → OAuth clients, use the client from
Phase 0 (scopes **Auth Keys: write** and **Devices Core: write**, tag `tag:mc-player`).
If you've lost its secret, make a new one with the same scopes and tag.

```bash
cd apps/worker
bunx wrangler secret put TS_OAUTH_CLIENT_ID
bunx wrangler secret put TS_OAUTH_CLIENT_SECRET
```

## 2. Deploy and register

```bash
bunx wrangler d1 migrations apply mc-bot --remote   # adds enrollments and devices
bun run deploy
DISCORD_APP_ID=<id> DISCORD_GUILD_ID=<id> DISCORD_BOT_TOKEN=<token> bun run register
```

In Server Settings → Integrations → your bot, allow the `MC Maintainer` role to use `/tailnet`
(it's registered hidden, like `/host`).

## 3. Release mc-host

`apps/agent/package.json` holds the version. `MIN_AGENT_VERSION` in `wrangler.jsonc` is the
oldest version the Worker accepts; raise it only when the agent API changes.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Check that the release on GitHub has `mc-host-windows-x64.exe`, `mc-host-linux-x64` and
`SHA256SUMS`. Your own Linux install builds from the checkout, so re-run `scripts/install.sh`
after pulling (0.1.0 agents are now refused).

## 4. Letting someone back in

`/tailnet revoke` blocks a person. To undo it, run `mc-host admin token mint <discord-id> <name>`,
then they run `/setup` again.

## 5. If Windows Defender blocks mc-host.exe

Unsigned programs built with Bun are sometimes flagged. If it happens: Windows Security →
Virus & threat protection → Protection history → Allow, or add
`%LOCALAPPDATA%\mc-host\bin` under Exclusions.

## Checklist (clean Windows 10/11 VM)

- [ ] `/setup` → paste the line → one permission prompt → "You're on the Minecraft network"
- [ ] The device shows up in the Tailscale admin tagged `tag:mc-player`, named `mc-<username>`
- [ ] Host from Fedora; the VM joins through Prism (import the `/modpack` link)
- [ ] Running the same line again says the link expired
- [ ] `/setup host:True` on the same VM: no Tailscale install, no network key minted; `mc-host.exe`, the **Host Minecraft** shortcut and the two `Minecraft (mc-host)` firewall rules appear; `mc-host status` prints
- [ ] `mc-host --version` in a new terminal prints `mc-host 0.2.0` (PATH works)
- [ ] Host from the shortcut: the JRE downloads and extracts, the 🟢 announcement shows a `100.x` address, and Fedora joins
- [ ] If Windows asks about Java's network access, note what it asked (it shouldn't, thanks to the port rules)
- [ ] Ctrl+C: the world saves and uploads, and the 🔴 announcement shows the new rev
- [ ] Download that rev on Fedora (`/world download`) and host it there: the world opens with everything intact (Windows → Linux zip paths)
- [ ] Host from the shortcut again, close the window mid-session; the next start offers to upload the local world
- [ ] `/tailnet revoke` the VM's user: the device disappears from the admin, `mc-host start` is refused, and `/setup` says they were removed
- [ ] `mc-host admin token mint` lets them back in, and `/setup` works again
- [ ] Invite friends
````

- [ ] **Step 3: Update `ROADMAP.md`**

Under Phase 4, add the setup guide link under the design line:

```markdown
Setup guide: [docs/setup/phase-4.md](docs/setup/phase-4.md)
```

Leave the checkboxes unticked. They're ticked after the VM checklist passes.

- [ ] **Step 4: Commit**

```bash
git add docs ROADMAP.md
git commit -m "docs: phase 4 setup guide; spec matches the plan"
```
