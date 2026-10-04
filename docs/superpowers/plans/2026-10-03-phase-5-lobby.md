# Phase 5: Lobby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 24/7 Paper lobby at the tailnet name `mc-lobby` that sends players to whoever is hosting (10 s countdown, `/stay`, `/play`), backs itself up to R2, and gets players sent back to it when a host stops.

**Architecture:** The Worker gains a lobby slot (a one-row lease), `lobby`-scoped tokens, lobby backups in R2, and the lobby's address in the agent manifest and in `/status` and `/join`. `mc-host lobby` claims the slot, restores or creates the lobby folder, runs Paper 26.3, polls the Worker every 5 s, and writes `lobbybridge …` console commands to Paper's stdin. The Java plugin `lobby-bridge` turns those into countdowns and `Player#transfer`. Hosts set `accepts-transfers=true` and run `transfer <lobby> 25565 @a` before stopping.

**Tech Stack:** TypeScript (Bun for the agent, Cloudflare Workers + Hono + D1 + R2 for the Worker, zod for the protocol), Vitest with the Workers pool, `bun test`, Java 25 + Paper API `26.3.build.147-beta` + JUnit 6.1.3, Gradle 9.8 run in Docker, Docker Compose with a Tailscale sidecar.

**Spec:** [docs/superpowers/specs/2026-10-03-phase-5-lobby-design.md](../specs/2026-10-03-phase-5-lobby-design.md)

## Global Constraints

- Every message a person sees is plain English and says what to do next.
- Game port `25565`. Tailnet name of the lobby: `mc-lobby`.
- Lobby polls every `5_000` ms; the slot expires after `2 * 60_000` ms without a poll (`LOBBY_MS`).
- Lobby backups every `30 * 60_000` ms and on stop; keep the last `3`. R2 keys: `lobby/<rev>-<uuid>.zip`.
- Countdown: `10` seconds. Players joining while a host is up are sent on the next one-second tick.
- Paper `26.3` build `147`, sha256 `e88207b474f1954f4de175a0b63a3d574e995f609d7fd9c4960d4f76e1784ae3`, Java `25`.
- Never back up: `cache`, `libraries`, `versions`, `logs`, `crash-reports`, `paper.jar`, `plugins/.paper-remapped`, `plugins/lobby-bridge.jar`, and any `session.lock`.
- No jars, maps or world data in git (`.gitignore` already blocks `*.jar` and `*.zip`).
- Lobby tokens are refused on `/agent/*`; host tokens are refused on `/lobby/*`.
- Hosting must work exactly as before when the lobby is down: the send-back step is skipped, and the manifest lookup for it gives up after 3 s.
- `apps/agent/package.json` version becomes `0.4.0`. `MIN_AGENT_VERSION` stays `0.3.0`.

## Review Focus

- **Fedora comes back after the Pi has been the lobby for a while.** Its local folder is older than the newest backup. It must be moved aside and the backup restored, never uploaded over the newer one. Pinned in Task 9 ("a machine whose lobby is older than the backup…").
- **Docker restarts the lobby within the 2-minute expiry.** The same machine must get its slot back immediately, not be refused by its own previous session. Pinned in Task 3 ("lets the same machine take its slot back…") and Task 9 ("a restart on the same machine asks for its previous session").
- **A Worker outage longer than 2 minutes.** The slot lapses, the next poll gets `lease_lost`, and the lobby must claim the slot back rather than shut down. It stops (without a backup) only if another lobby really took over. Pinned in Task 9 ("a lapsed session is claimed back…").
- **Discord names with spaces or tabs** in the console command. The holder must arrive in the plugin as one argument, intact. Pinned in Task 9 (`bridgeCommand`) and Task 11 (`consoleCommand`).
- **The Worker hangs or is unreachable while a host stops.** The stop must not wait forever for the lobby lookup. Pinned in Task 10 ("a Worker that doesn't answer doesn't hold up the stop").

---

## File map

```
packages/protocol/src/index.ts            MODIFY  lobby request/response schemas; manifest.lobby
packages/protocol/test/protocol.test.ts   MODIFY

apps/worker/migrations/0004_lobby.sql     NEW     users.scope, lobby_slot, lobby_backups
apps/worker/src/auth.ts                   MODIFY  token scopes; lobbyAuth
apps/worker/src/users.ts                  MODIFY  mintLobbyToken
apps/worker/src/lobby.ts                  NEW     slot claim/poll/release, lobbyHost, lobbyAddress, LOBBY_NAME
apps/worker/src/lobby-backups.ts          NEW     upload target, commit, prune, latest
apps/worker/src/snapshots.ts              MODIFY  verifyObject → exported verifyUpload(prefix)
apps/worker/src/routes/lobby.ts           NEW     /lobby/* routes
apps/worker/src/routes/admin.ts           MODIFY  /admin/lobby/token, /admin/lobby/release
apps/worker/src/routes/agent.ts           MODIFY  manifest.lobby
apps/worker/src/index.ts                  MODIFY  mount /lobby
apps/worker/src/commands/status.ts        MODIFY  lobby line
apps/worker/src/commands/join.ts          MODIFY  mc-lobby step
apps/worker/test/helpers.ts               MODIFY  addLobby, lobbyUp
apps/worker/test/lobby.vitest.ts          NEW
apps/worker/test/agent.vitest.ts          MODIFY
apps/worker/test/info-commands.vitest.ts  MODIFY

apps/agent/package.json                   MODIFY  0.4.0
apps/agent/src/cli.ts                     MODIFY  lobby [--fresh], admin lobby token|release
apps/agent/src/commands.ts                MODIFY  dispatch
apps/agent/src/admin.ts                   MODIFY  admin lobby commands
apps/agent/src/host/api.ts                MODIFY  LobbyApi; admin lobby calls
apps/agent/src/host/deps.ts               MODIFY  realTimers, SEND_BACK_MS, LOBBY_LOOKUP_MS
apps/agent/src/host/commands.ts           MODIFY  use realTimers
apps/agent/src/host/snapshot.ts           MODIFY  zipTree, extractZip (generic); world wrappers unchanged
apps/agent/src/host/prepare.ts            MODIFY  accepts-transfers=true
apps/agent/src/host/run.ts                MODIFY  send players to the lobby before stop
apps/agent/src/lobby/folder.ts            NEW     paths, state, backup zip/restore, move aside
apps/agent/src/lobby/paper.ts             NEW     pinned Paper, plugin copy, fresh properties, java command
apps/agent/src/lobby/bridge.ts            NEW     bridgeCommand
apps/agent/src/lobby/run.ts               NEW     runLobby: claim, restore, launch, poll, backup, stop
apps/agent/src/lobby/command.ts           NEW     cmdLobby: real deps
apps/agent/test/lobby-fakes.ts            NEW
apps/agent/test/lobby-folder.test.ts      NEW
apps/agent/test/lobby-paper.test.ts       NEW
apps/agent/test/lobby-run.test.ts         NEW
apps/agent/test/lobby-command.test.ts     NEW
apps/agent/test/host-fakes.ts             MODIFY  manifestFor({ lobby })
apps/agent/test/{api,cli,prepare,hosted,integration}.test.ts  MODIFY

paper/lobby-bridge/                       NEW     Gradle project: Host, Lobby, Bridge, PaperLobby, LobbyBridgePlugin, tests
scripts/gradle.sh                         NEW     Gradle in Docker
scripts/install-lobby.sh                  NEW
infra/docker/lobby.Dockerfile             NEW
infra/docker/lobby-compose.yml            NEW
docs/setup/phase-5.md                     NEW
package.json, .gitignore, ROADMAP.md      MODIFY
```

---

### Task 1: Protocol types

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/protocol.test.ts`
- Modify: `apps/worker/src/routes/agent.ts` (temporary `lobby: null`, replaced in Task 5)
- Modify: `apps/worker/test/agent.vitest.ts`
- Modify: `apps/agent/test/host-fakes.ts`

**Interfaces:**
- Produces (all exported from `@mc/protocol`):
  - `LobbyNameSchema`, `LobbyTokenRequestSchema` / `LobbyTokenRequest { name }`
  - `LobbyClaimRequestSchema` / `LobbyClaimRequest { address: string; machine: string; previousSessionId?: string }`
  - `LobbyClaimResponseSchema` / `LobbyClaimResponse { sessionId: string; expiresAt: number }`
  - `LobbyHostSchema` / `LobbyHost { name: string; address: string; world: string; minecraft: string }`
  - `LobbyPollResponseSchema` / `LobbyPollResponse { host: LobbyHost | null; expiresAt: number }`
  - `LobbyUploadUrlRequestSchema` / `LobbyUploadUrlRequest { sessionId; size; sha256 }`
  - `LobbyCommitRequestSchema` / `LobbyCommitRequest { sessionId; rev; key; size; sha256 }`
  - `LobbyLatestResponseSchema` / `LobbyLatestResponse { latest: SnapshotRef | null }`
  - `LobbyReleaseResponseSchema` / `LobbyReleaseResponse { released: { machine: string; address: string } | null }`
  - `Manifest.lobby: { address: string } | null` (defaults to `null` when an older Worker leaves it out)

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/test/protocol.test.ts` and add the new names to its import list from `"../src/index"`: `LobbyClaimRequestSchema`, `LobbyTokenRequestSchema`.

```ts
test("a manifest from an older Worker has no lobby", () => {
  const m = ManifestSchema.parse({
    world: { id: "w", name: "w", minecraft: "26.3" },
    profile: {},
    lockfile: {},
    pregenDone: false,
    latest: null,
    lease: null,
  });
  expect(m.lobby).toBeNull();
  expect(ManifestSchema.parse({ ...m, lobby: { address: "100.64.0.50" } }).lobby).toEqual({ address: "100.64.0.50" });
});

test("lobby names are slugs, and a claim needs an address and a machine", () => {
  expect(LobbyTokenRequestSchema.safeParse({ name: "fedora" }).success).toBe(true);
  expect(LobbyTokenRequestSchema.safeParse({ name: "Fedora Box" }).success).toBe(false);
  expect(LobbyClaimRequestSchema.safeParse({ address: "100.64.0.50", machine: "fedora" }).success).toBe(true);
  expect(LobbyClaimRequestSchema.safeParse({ address: "", machine: "fedora" }).success).toBe(false);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test packages/protocol`
Expected: FAIL, `LobbyClaimRequestSchema` is not exported.

- [ ] **Step 3: Add the schemas**

In `packages/protocol/src/index.ts`, add `lobby` to `ManifestSchema` after `lease`:

```ts
  /** Null when no lobby is running. Older Workers leave it out. */
  lobby: z.object({ address: z.string() }).nullable().default(null),
```

Append at the end of the file:

```ts
export const LobbyNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "must be up to 32 lowercase letters, digits and dashes, like fedora or pi");
export const LobbyTokenRequestSchema = z.object({ name: LobbyNameSchema });
export type LobbyTokenRequest = z.infer<typeof LobbyTokenRequestSchema>;
export const LobbyClaimRequestSchema = z.object({
  address: z.string().min(1).max(64),
  /** The machine's own name, shown to a second lobby that's refused. */
  machine: z.string().min(1).max(64),
  /** This machine's last session, so a restart within the expiry gets the slot back. */
  previousSessionId: SessionId.optional(),
});
export type LobbyClaimRequest = z.infer<typeof LobbyClaimRequestSchema>;
export const LobbyClaimResponseSchema = z.object({ sessionId: SessionId, expiresAt: z.number() });
export type LobbyClaimResponse = z.infer<typeof LobbyClaimResponseSchema>;
export const LobbyHostSchema = z.object({ name: z.string(), address: z.string(), world: z.string(), minecraft: z.string() });
export type LobbyHost = z.infer<typeof LobbyHostSchema>;
export const LobbyPollResponseSchema = z.object({ host: LobbyHostSchema.nullable(), expiresAt: z.number() });
export type LobbyPollResponse = z.infer<typeof LobbyPollResponseSchema>;
export const LobbyUploadUrlRequestSchema = z.object({ sessionId: SessionId, size: Size, sha256: Sha256Schema });
export type LobbyUploadUrlRequest = z.infer<typeof LobbyUploadUrlRequestSchema>;
export const LobbyCommitRequestSchema = z.object({
  sessionId: SessionId,
  rev: PositiveRev,
  key: z.string().min(1),
  size: Size,
  sha256: Sha256Schema,
});
export type LobbyCommitRequest = z.infer<typeof LobbyCommitRequestSchema>;
export const LobbyLatestResponseSchema = z.object({ latest: SnapshotRefSchema.nullable() });
export type LobbyLatestResponse = z.infer<typeof LobbyLatestResponseSchema>;
export const LobbyReleaseResponseSchema = z.object({
  released: z.object({ machine: z.string(), address: z.string() }).nullable(),
});
export type LobbyReleaseResponse = z.infer<typeof LobbyReleaseResponseSchema>;
```

- [ ] **Step 4: Keep the callers compiling**

`Manifest` now requires `lobby`. In `apps/worker/src/routes/agent.ts`, inside the `body: Manifest = { … }` literal, add after `lease`:

```ts
    lobby: null,
```

In `apps/worker/test/agent.vitest.ts`, in the `"describes a fresh world with its pinned files"` test, add `lobby: null,` after `lease: null,` in the expected object.

In `apps/agent/test/host-fakes.ts`, give `manifestFor` a `lobby` option. Add `lobby?: { address: string } | null;` to its option type, and `lobby: o.lobby ?? null,` to the returned object after `lease`.

- [ ] **Step 5: Run the tests and the type check**

Run: `bun test packages/protocol && bun run typecheck && bun run --cwd apps/worker test -- agent`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol apps/worker/src/routes/agent.ts apps/worker/test/agent.vitest.ts apps/agent/test/host-fakes.ts
git commit -m "feat(protocol): lobby schemas and manifest.lobby"
```

---

### Task 2: Worker, token scopes and lobby tokens

**Files:**
- Create: `apps/worker/migrations/0004_lobby.sql`
- Modify: `apps/worker/src/auth.ts`
- Modify: `apps/worker/src/users.ts`
- Modify: `apps/worker/src/routes/admin.ts`
- Modify: `apps/worker/test/helpers.ts`
- Create: `apps/worker/test/lobby.vitest.ts`

**Interfaces:**
- Consumes: `LobbyTokenRequestSchema`, `MintTokenResponse` from Task 1.
- Produces:
  - `lobbyAuth` middleware (sets `c.var.userId` / `c.var.userName`, like `agentAuth`)
  - `mintLobbyToken(db: D1Database, name: string, now: number): Promise<string>`. Its user row is `discord_id = "lobby-<name>"`, `name = "lobby <name>"`, `scope = 'lobby'`.
  - `POST /admin/lobby/token { name }` → `201 { token }`
  - Test helpers `addLobby(name?: string): Promise<string>` and `lobbyUp(address?: string, expiresAt?: number): Promise<void>`

- [ ] **Step 1: Write the migration**

`apps/worker/migrations/0004_lobby.sql`:

```sql
-- Who a token is for: someone who hosts, or a lobby server. Lobby tokens can't host.
ALTER TABLE users ADD COLUMN scope TEXT NOT NULL DEFAULT 'host' CHECK (scope IN ('host', 'lobby'));

-- A single row; holder_id IS NULL means no lobby is running.
CREATE TABLE lobby_slot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder_id TEXT REFERENCES users (discord_id),
  machine TEXT,
  session_id TEXT,
  address TEXT,
  claimed_at INTEGER,
  expires_at INTEGER
);
INSERT INTO lobby_slot (id) VALUES (1);

-- The lobby folder (world, plugins, configs) zipped. The bytes are in R2 at lobby/<rev>-<uuid>.zip.
CREATE TABLE lobby_backups (
  rev INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Add the test helpers**

Append to `apps/worker/test/helpers.ts`:

```ts
/** Insert a lobby-scoped user directly and return its plaintext token. */
export async function addLobby(name = "fedora"): Promise<string> {
  const token = `lobby-token-${name}-0123456789abcdef0123456789`;
  await env.DB.prepare("INSERT INTO users (discord_id, name, token_hash, created_at, scope) VALUES (?, ?, ?, 1, 'lobby')")
    .bind(`lobby-${name}`, `lobby ${name}`, await sha256Hex(token))
    .run();
  return token;
}

/** Put a lobby in the slot as if it had just polled. */
export async function lobbyUp(address = "100.64.0.50", expiresAt = Date.now() + 60_000): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (discord_id, name, token_hash, created_at, scope) VALUES ('lobby-up', 'lobby up', 'lobby-up-hash', 1, 'lobby') ON CONFLICT (discord_id) DO NOTHING",
  ).run();
  await env.DB.prepare(
    "UPDATE lobby_slot SET holder_id = 'lobby-up', machine = 'fedora', session_id = 'lobby-session-0123456789', address = ?, claimed_at = ?, expires_at = ? WHERE id = 1",
  )
    .bind(address, Date.now(), expiresAt)
    .run();
}
```

- [ ] **Step 3: Write the failing tests**

`apps/worker/test/lobby.vitest.ts`:

```ts
import { sha256Hex } from "@mc/profile";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { addLobby, addUser, call } from "./helpers";

const ALEX = "100000000000000001";
let alex: string;
let lobby: string;
beforeEach(async () => {
  alex = await addUser(ALEX, "Alex");
  lobby = await addLobby("fedora");
});

describe("lobby tokens", () => {
  it("a lobby token can't use the hosting API", async () => {
    expect((await call("GET", "/agent/manifest", { token: lobby })).status).toBe(401);
  });

  it("the admin mints a lobby token, and minting again replaces it", async () => {
    const first = await call("POST", "/admin/lobby/token", { admin: true, body: { name: "pi" } });
    expect(first.status).toBe(201);
    expect(await env.DB.prepare("SELECT name, scope FROM users WHERE discord_id = 'lobby-pi'").first()).toEqual({ name: "lobby pi", scope: "lobby" });
    const second = await call("POST", "/admin/lobby/token", { admin: true, body: { name: "pi" } });
    expect(second.body.token).not.toBe(first.body.token);
    expect(await env.DB.prepare("SELECT token_hash FROM users WHERE discord_id = 'lobby-pi'").first("token_hash")).toBe(await sha256Hex(second.body.token));
  });

  it("refuses a lobby name that isn't a slug", async () => {
    expect((await call("POST", "/admin/lobby/token", { admin: true, body: { name: "My Pi" } })).status).toBe(400);
  });
});
```

`alex` is used by later tasks' tests in this file. Leave it.

- [ ] **Step 4: Run the tests to make sure they fail**

Run: `bun run --cwd apps/worker test -- lobby`
Expected: FAIL. The first test gets 200 instead of 401, and `/admin/lobby/token` is 404.

- [ ] **Step 5: Implement the scopes**

In `apps/worker/src/auth.ts`, replace `agentAuth` with a factory:

```ts
/** A token of the given scope. Host tokens are refused on the lobby API and the other way round. */
function tokenAuth(scope: "host" | "lobby") {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = bearer(c.req.header("Authorization"));
    if (!token) throw rejected();
    const row = await c.env.DB.prepare(
      "SELECT discord_id, name FROM users WHERE token_hash = ? AND revoked_at IS NULL AND scope = ?",
    )
      .bind(await hashToken(token), scope)
      .first<{ discord_id: string; name: string }>();
    if (!row) throw rejected();
    c.set("userId", row.discord_id);
    c.set("userName", row.name);
    await next();
  });
}

export const agentAuth = tokenAuth("host");
export const lobbyAuth = tokenAuth("lobby");
```

`agentOrAdminAuth` keeps calling `agentAuth(c, next)` unchanged.

Append to `apps/worker/src/users.ts`:

```ts
/** A token for the lobby server on one machine. Its user row can never host. */
export async function mintLobbyToken(db: D1Database, name: string, now: number): Promise<string> {
  const token = randomToken();
  await db
    .prepare(
      `INSERT INTO users (discord_id, name, token_hash, created_at, scope) VALUES (?1, ?2, ?3, ?4, 'lobby')
       ON CONFLICT (discord_id) DO UPDATE SET token_hash = excluded.token_hash, revoked_at = NULL`,
    )
    .bind(`lobby-${name}`, `lobby ${name}`, await hashToken(token), now)
    .run();
  return token;
}
```

In `apps/worker/src/routes/admin.ts`, add `LobbyTokenRequestSchema` to the `@mc/protocol` import, `mintLobbyToken` to the `../users` import, and this route after `/tokens`:

```ts
admin.post("/lobby/token", async (c) => {
  const { name } = await readBody(c, LobbyTokenRequestSchema);
  const body: MintTokenResponse = { token: await mintLobbyToken(c.env.DB, name, Date.now()) };
  return c.json(body, 201);
});
```

- [ ] **Step 6: Run all Worker tests**

Run: `bun run --cwd apps/worker test`
Expected: PASS. Existing host tokens default to scope `host`, so the earlier tests are unaffected.

- [ ] **Step 7: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): lobby-scoped tokens and the lobby tables"
```

---

### Task 3: Worker, the lobby slot

**Files:**
- Create: `apps/worker/src/lobby.ts`
- Create: `apps/worker/src/routes/lobby.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/routes/admin.ts`
- Modify: `apps/worker/test/lobby.vitest.ts`

**Interfaces:**
- Consumes: `lobbyAuth` (Task 2), `LobbyClaimRequestSchema`, `LobbyClaimResponse`, `LobbyPollResponse`, `LobbyReleaseResponse`, `SessionRequestSchema`, `Ok` (Task 1).
- Produces (`apps/worker/src/lobby.ts`):
  - `LOBBY_MS = 120_000`, `LOBBY_NAME = "mc-lobby"`
  - `interface LobbySlotRow { holder_id; machine; session_id; address; claimed_at; expires_at }` (all nullable)
  - `readSlot(db): Promise<LobbySlotRow>`, `isUp(slot, now): boolean`, `slotLostError(): ApiError`
  - `claimSlot(db, { userId, machine, address, previousSessionId?, now }): Promise<{ sessionId; expiresAt }>`
  - `pollSlot(db, sessionId, now): Promise<number>` (the new expiry)
  - `releaseSlot(db, sessionId): Promise<void>`, `forceReleaseSlot(db, now): Promise<{ machine; address } | null>`
  - `requireSlotSession(db, sessionId): Promise<void>`
  - `lobbyHost(db, now): Promise<LobbyHost | null>`, `lobbyAddress(db, now): Promise<{ address: string } | null>`
- Routes: `POST /lobby/claim`, `POST /lobby/poll`, `POST /lobby/release`, `POST /admin/lobby/release`

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/lobby.vitest.ts`. Add `addWorld` and `hostSince` to the `./helpers` import, and add `import { LOBBY_MS } from "../src/lobby";`.

```ts
const claimAs = (o: { machine?: string; previousSessionId?: string; token?: string } = {}) =>
  call("POST", "/lobby/claim", {
    token: o.token ?? lobby,
    body: { address: "100.64.0.50", machine: o.machine ?? "fedora", ...(o.previousSessionId ? { previousSessionId: o.previousSessionId } : {}) },
  });
const poll = (sessionId: string) => call("POST", "/lobby/poll", { token: lobby, body: { sessionId } });

describe("the lobby slot", () => {
  it("claims a free slot and polls with nobody hosting", async () => {
    const c = await claimAs();
    expect(c.status).toBe(200);
    const p = await poll(c.body.sessionId);
    expect(p.body.host).toBeNull();
    expect(p.body.expiresAt).toBeGreaterThan(Date.now() + LOBBY_MS - 10_000);
  });

  it("refuses a second machine while the first is up, naming it", async () => {
    await claimAs();
    const r = await claimAs({ machine: "pi" });
    expect(r.status).toBe(409);
    expect(r.body.message).toBe(
      "The lobby is already running on fedora (heard from it just now). Stop it there first, or run `mc-host admin lobby release`.",
    );
  });

  it("lets the same machine take its slot back after a restart, ending the old session", async () => {
    const first = await claimAs();
    const again = await claimAs({ previousSessionId: first.body.sessionId });
    expect(again.status).toBe(200);
    expect(again.body.sessionId).not.toBe(first.body.sessionId);
    expect((await poll(first.body.sessionId)).body.error).toBe("lease_lost");
  });

  it("lets any machine take an expired slot", async () => {
    await claimAs();
    await env.DB.prepare("UPDATE lobby_slot SET expires_at = ? WHERE id = 1").bind(Date.now() - 1).run();
    expect((await claimAs({ machine: "pi" })).status).toBe(200);
  });

  it("poll shows who is hosting the active world", async () => {
    await addWorld("w1");
    await hostSince(ALEX, "w1", 60_000);
    const c = await claimAs();
    expect((await poll(c.body.sessionId)).body.host).toEqual({ name: "Alex", address: "100.64.0.3", world: "w1", minecraft: "26.3" });
  });

  it("release frees the slot, and the admin can force it", async () => {
    const c = await claimAs();
    expect((await call("POST", "/lobby/release", { token: lobby, body: { sessionId: c.body.sessionId } })).body).toEqual({ ok: true });
    await claimAs({ machine: "pi" });
    expect((await call("POST", "/admin/lobby/release", { admin: true })).body).toEqual({ released: { machine: "pi", address: "100.64.0.50" } });
    expect((await call("POST", "/admin/lobby/release", { admin: true })).body).toEqual({ released: null });
  });

  it("a hosting token can't use the lobby API", async () => {
    expect((await claimAs({ token: alex })).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun run --cwd apps/worker test -- lobby`
Expected: FAIL, `../src/lobby` doesn't exist.

- [ ] **Step 3: Write `apps/worker/src/lobby.ts`**

```ts
import type { LobbyHost } from "@mc/protocol";
import { ago } from "./discord/format";
import { ApiError } from "./errors";
import { isHeld, readLease } from "./lease";
import { activeWorld } from "./worlds";

/** The lobby polls every 5 s; two minutes of silence means it's gone. */
export const LOBBY_MS = 2 * 60_000;
/** The lobby's tailnet name, set in infra/docker/lobby-compose.yml. */
export const LOBBY_NAME = "mc-lobby";

export interface LobbySlotRow {
  holder_id: string | null;
  machine: string | null;
  session_id: string | null;
  address: string | null;
  claimed_at: number | null;
  expires_at: number | null;
}

const CLEAR_SLOT =
  "UPDATE lobby_slot SET holder_id = NULL, machine = NULL, session_id = NULL, address = NULL, claimed_at = NULL, expires_at = NULL";

export function slotLostError(): ApiError {
  return new ApiError("lease_lost", "This lobby session is no longer valid: another lobby took over, or a maintainer released it.");
}

export async function readSlot(db: D1Database): Promise<LobbySlotRow> {
  const row = await db
    .prepare("SELECT holder_id, machine, session_id, address, claimed_at, expires_at FROM lobby_slot WHERE id = 1")
    .first<LobbySlotRow>();
  if (!row) throw new Error("The lobby_slot row is missing. Apply the D1 migrations.");
  return row;
}

export const isUp = (s: LobbySlotRow, now: number): boolean => s.holder_id !== null && (s.expires_at ?? 0) >= now;

/** One conditional UPDATE: the slot is free, expired, or held by this machine's previous session. */
export async function claimSlot(
  db: D1Database,
  o: { userId: string; machine: string; address: string; previousSessionId?: string; now: number },
): Promise<{ sessionId: string; expiresAt: number }> {
  const row = await db
    .prepare(
      `UPDATE lobby_slot SET holder_id = ?1, machine = ?2, session_id = ?3, address = ?4, claimed_at = ?5, expires_at = ?6
       WHERE id = 1 AND (holder_id IS NULL OR expires_at < ?5 OR session_id = ?7)
       RETURNING session_id, expires_at`,
    )
    .bind(o.userId, o.machine, crypto.randomUUID(), o.address, o.now, o.now + LOBBY_MS, o.previousSessionId ?? null)
    .first<{ session_id: string; expires_at: number }>();
  if (row) return { sessionId: row.session_id, expiresAt: row.expires_at };
  const s = await readSlot(db);
  const heard = ago(o.now - ((s.expires_at ?? o.now) - LOBBY_MS));
  throw new ApiError(
    "lease_held",
    `The lobby is already running on ${s.machine ?? "another machine"} (heard from it ${heard}). Stop it there first, or run \`mc-host admin lobby release\`.`,
  );
}

export async function pollSlot(db: D1Database, sessionId: string, now: number): Promise<number> {
  const r = await db.prepare("UPDATE lobby_slot SET expires_at = ?1 WHERE id = 1 AND session_id = ?2").bind(now + LOBBY_MS, sessionId).run();
  if (r.meta.changes !== 1) throw slotLostError();
  return now + LOBBY_MS;
}

export async function releaseSlot(db: D1Database, sessionId: string): Promise<void> {
  const r = await db.prepare(`${CLEAR_SLOT} WHERE id = 1 AND session_id = ?`).bind(sessionId).run();
  if (r.meta.changes !== 1) throw slotLostError();
}

/** Maintainer override for a lobby machine that died. Returns who held it, or null if nobody did. */
export async function forceReleaseSlot(db: D1Database, now: number): Promise<{ machine: string; address: string } | null> {
  const s = await readSlot(db);
  await db.prepare(`${CLEAR_SLOT} WHERE id = 1`).run();
  return isUp(s, now) ? { machine: s.machine ?? "an unknown machine", address: s.address ?? "an unknown address" } : null;
}

export async function requireSlotSession(db: D1Database, sessionId: string): Promise<void> {
  const s = await readSlot(db);
  if (!s.holder_id || s.session_id !== sessionId) throw slotLostError();
}

/** Who the lobby should send players to: the holder of a live lease on the active world. */
export async function lobbyHost(db: D1Database, now: number): Promise<LobbyHost | null> {
  const [lease, world] = await Promise.all([readLease(db), activeWorld(db)]);
  if (!world || !isHeld(lease, now) || lease.world_id !== world.id || !lease.host_address) return null;
  return { name: lease.holder_name ?? "Someone", address: lease.host_address, world: world.name, minecraft: world.mc_version };
}

export async function lobbyAddress(db: D1Database, now: number): Promise<{ address: string } | null> {
  const s = await readSlot(db);
  return isUp(s, now) && s.address ? { address: s.address } : null;
}
```

- [ ] **Step 4: Write the routes**

`apps/worker/src/routes/lobby.ts`:

```ts
import { LobbyClaimRequestSchema, SessionRequestSchema, type LobbyClaimResponse, type LobbyPollResponse, type Ok } from "@mc/protocol";
import { Hono } from "hono";
import { lobbyAuth } from "../auth";
import type { AppEnv } from "../env";
import { readBody } from "../errors";
import { claimSlot, lobbyHost, pollSlot, releaseSlot } from "../lobby";
import { versionCheck } from "../version";

export const lobby = new Hono<AppEnv>();
lobby.use("*", versionCheck);
lobby.use("*", lobbyAuth);

lobby.post("/claim", async (c) => {
  const req = await readBody(c, LobbyClaimRequestSchema);
  const body: LobbyClaimResponse = await claimSlot(c.env.DB, { ...req, userId: c.var.userId, now: Date.now() });
  return c.json(body);
});

/** The lobby's heartbeat, answered with who it should send players to. */
lobby.post("/poll", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  const now = Date.now();
  const expiresAt = await pollSlot(c.env.DB, sessionId, now);
  const body: LobbyPollResponse = { host: await lobbyHost(c.env.DB, now), expiresAt };
  return c.json(body);
});

lobby.post("/release", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  await releaseSlot(c.env.DB, sessionId);
  const body: Ok = { ok: true };
  return c.json(body);
});
```

In `apps/worker/src/index.ts`, add `import { lobby } from "./routes/lobby";` and `app.route("/lobby", lobby);` after the `/agent` route.

In `apps/worker/src/routes/admin.ts`, add `type LobbyReleaseResponse` to the `@mc/protocol` import, `import { forceReleaseSlot } from "../lobby";`, and after `/lobby/token`:

```ts
admin.post("/lobby/release", async (c) => {
  const body: LobbyReleaseResponse = { released: await forceReleaseSlot(c.env.DB, Date.now()) };
  return c.json(body);
});
```

- [ ] **Step 5: Run the tests**

Run: `bun run --cwd apps/worker test -- lobby && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): the lobby slot: claim, poll, release"
```

---

### Task 4: Worker, lobby backups

**Files:**
- Modify: `apps/worker/src/snapshots.ts`
- Create: `apps/worker/src/lobby-backups.ts`
- Modify: `apps/worker/src/routes/lobby.ts`
- Modify: `apps/worker/test/lobby.vitest.ts`

**Interfaces:**
- Consumes: `requireSlotSession`, `readSlot`, `slotLostError` (Task 3); `LobbyUploadUrlRequestSchema`, `LobbyCommitRequestSchema`, `LobbyLatestResponse`, `UploadTarget`, `CommitResponse` (Task 1); `revOfKey` from `worlds.ts`.
- Produces:
  - `verifyUpload(bucket, { prefix, key, size, sha256 }, wrongKey: string): Promise<void>` exported from `snapshots.ts`
  - `KEEP_LOBBY_BACKUPS = 3`, `latestBackup(db)`, `beginLobbyUpload(env, requestUrl, { sessionId, sha256 })`, `commitLobbyBackup(env, { sessionId, rev, key, size, sha256, now })`, `pruneLobbyBackups(env, keep)`
  - Routes `POST /lobby/backup/upload-url`, `POST /lobby/backup/commit` → `{ rev }`, `GET /lobby/backup/latest` → `{ latest }`

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/lobby.vitest.ts`. Add these imports at the top: `import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";` and `import { app } from "../src/index";`.

```ts
/** upload-url, then PUT through the dev R2 proxy. Commit is left to the test. */
async function backup(sessionId: string, data: string) {
  const sha256 = await sha256Hex(data);
  const t = await call("POST", "/lobby/backup/upload-url", { token: lobby, body: { sessionId, size: data.length, sha256 } });
  expect(t.status).toBe(200);
  const ctx = createExecutionContext();
  await app.request(t.body.url, { method: "PUT", headers: t.body.headers, body: data }, env, ctx);
  await waitOnExecutionContext(ctx);
  return {
    target: t.body,
    commit: () =>
      call("POST", "/lobby/backup/commit", { token: lobby, body: { sessionId, rev: t.body.rev, key: t.body.key, size: data.length, sha256 } }),
  };
}

describe("lobby backups", () => {
  it("backs up, then hands out the latest", async () => {
    const s = (await claimAs()).body.sessionId;
    expect((await call("GET", "/lobby/backup/latest", { token: lobby })).body).toEqual({ latest: null });
    const b = await backup(s, "first");
    expect(b.target.key).toMatch(/^lobby\/1-[0-9a-f-]+\.zip$/);
    expect((await b.commit()).body).toEqual({ rev: 1 });
    const latest = (await call("GET", "/lobby/backup/latest", { token: lobby })).body.latest;
    expect(latest).toMatchObject({ rev: 1, size: 5, sha256: await sha256Hex("first") });
    expect(latest.url).toBe(`http://localhost/dev/r2/${b.target.key}`);
  });

  it("a retried commit is fine; a session that lost the slot can't back up", async () => {
    const s = (await claimAs()).body.sessionId;
    const b = await backup(s, "first");
    await b.commit();
    expect((await b.commit()).body).toEqual({ rev: 1 });
    await env.DB.prepare("UPDATE lobby_slot SET expires_at = ? WHERE id = 1").bind(Date.now() - 1).run();
    await claimAs({ machine: "pi" });
    const r = await call("POST", "/lobby/backup/upload-url", { token: lobby, body: { sessionId: s, size: 3, sha256: await sha256Hex("old") } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("lease_lost");
  });

  it("refuses a commit whose upload never arrived", async () => {
    const s = (await claimAs()).body.sessionId;
    const t = await call("POST", "/lobby/backup/upload-url", { token: lobby, body: { sessionId: s, size: 3, sha256: await sha256Hex("abc") } });
    const r = await call("POST", "/lobby/backup/commit", {
      token: lobby,
      body: { sessionId: s, rev: t.body.rev, key: t.body.key, size: 3, sha256: await sha256Hex("abc") },
    });
    expect(r.body.error).toBe("upload_missing");
  });

  it("keeps the last 3 backups", async () => {
    const s = (await claimAs()).body.sessionId;
    for (let i = 1; i <= 4; i++) await (await backup(s, `backup ${i}`)).commit();
    const revs = (await env.DB.prepare("SELECT rev FROM lobby_backups ORDER BY rev").all<{ rev: number }>()).results.map((r) => r.rev);
    expect(revs).toEqual([2, 3, 4]);
    expect((await env.BUCKET.list({ prefix: "lobby/" })).objects).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun run --cwd apps/worker test -- lobby`
Expected: FAIL, the backup routes are 404.

- [ ] **Step 3: Make the upload check reusable**

In `apps/worker/src/snapshots.ts`, replace `verifyObject` with:

```ts
/** The object at `key` sits under `prefix`, arrived complete, and matches its sha256. */
export async function verifyUpload(
  bucket: R2Bucket,
  o: { prefix: string; key: string; size: number; sha256: string },
  wrongKey: string,
): Promise<void> {
  if (!o.key.startsWith(o.prefix) || !o.key.endsWith(".zip")) throw new ApiError("bad_request", wrongKey);
  const head = await bucket.head(o.key);
  if (!head) throw new ApiError("upload_missing", "The upload didn't reach storage. Upload it again.");
  if (head.size !== o.size) {
    throw new ApiError("upload_missing", `The upload is incomplete (${head.size} of ${o.size} bytes). Upload it again.`);
  }
  const sum = head.checksums.sha256;
  if (sum && toHex(sum) !== o.sha256) throw new ApiError("upload_missing", "The upload doesn't match its sha256. Upload it again.");
}
```

In `commitSnapshot`, replace `await verifyObject(env.BUCKET, o);` with:

```ts
  await verifyUpload(
    env.BUCKET,
    { prefix: `worlds/${o.worldId}/${o.rev}-`, key: o.key, size: o.size, sha256: o.sha256 },
    "That upload key doesn't belong to this world and rev.",
  );
```

- [ ] **Step 4: Write `apps/worker/src/lobby-backups.ts`**

```ts
import type { UploadTarget } from "@mc/protocol";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { readSlot, requireSlotSession, slotLostError } from "./lobby";
import { verifyUpload } from "./snapshots";
import { storageFor } from "./storage";
import { revOfKey } from "./worlds";

export const KEEP_LOBBY_BACKUPS = 3;

export interface LobbyBackupRow {
  rev: number;
  r2_key: string;
  size: number;
  sha256: string;
  created_at: number;
}

export const lobbyBackupKey = (rev: number) => `lobby/${rev}-${crypto.randomUUID()}.zip`;

export const latestBackup = (db: D1Database) =>
  db.prepare("SELECT * FROM lobby_backups ORDER BY rev DESC LIMIT 1").first<LobbyBackupRow>();

export async function beginLobbyUpload(env: Env, requestUrl: string, o: { sessionId: string; sha256: string }): Promise<UploadTarget> {
  await requireSlotSession(env.DB, o.sessionId);
  const rev = ((await latestBackup(env.DB))?.rev ?? 0) + 1;
  const key = lobbyBackupKey(rev);
  return { rev, key, ...(await storageFor(env, requestUrl).putTarget(key, o.sha256)) };
}

/** Only the slot's current session may commit, and only as latest + 1, so two lobbies can't interleave backups. */
export async function commitLobbyBackup(
  env: Env,
  o: { sessionId: string; rev: number; key: string; size: number; sha256: string; now: number },
): Promise<void> {
  await verifyUpload(env.BUCKET, { prefix: `lobby/${o.rev}-`, key: o.key, size: o.size, sha256: o.sha256 }, "That upload key doesn't belong to this lobby backup.");
  const r = await env.DB.prepare(
    `INSERT INTO lobby_backups (rev, r2_key, size, sha256, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE EXISTS (SELECT 1 FROM lobby_slot WHERE id = 1 AND session_id = ?6)
       AND (SELECT COALESCE(MAX(rev), 0) FROM lobby_backups) = ?1 - 1`,
  )
    .bind(o.rev, o.key, o.size, o.sha256, o.now, o.sessionId)
    .run();
  if (r.meta.changes !== 1) {
    // A retry of a commit that already landed (its reply was lost) is not an error.
    const landed = await env.DB.prepare("SELECT 1 FROM lobby_backups WHERE rev = ? AND r2_key = ?").bind(o.rev, o.key).first();
    if (!landed) {
      if ((await readSlot(env.DB)).session_id !== o.sessionId) throw slotLostError();
      throw new ApiError("stale_rev", `Lobby backup ${o.rev} can't be committed because a newer backup exists.`);
    }
  }
  // Best effort: the commit has landed, so a failed cleanup must not turn it into an error.
  try {
    await pruneLobbyBackups(env, KEEP_LOBBY_BACKUPS);
  } catch (err) {
    console.error("pruning lobby backups failed", err);
  }
}

/** Keep the newest `keep` backups, and delete abandoned uploads at or below the latest rev. */
export async function pruneLobbyBackups(env: Pick<Env, "DB" | "BUCKET">, keep: number): Promise<void> {
  const rows = (await env.DB.prepare("SELECT rev, r2_key FROM lobby_backups ORDER BY rev DESC").all<{ rev: number; r2_key: string }>()).results;
  const dropped = rows.slice(keep);
  const kept = new Set(rows.slice(0, keep).map((r) => r.r2_key));
  const latestRev = rows[0]?.rev ?? 0;
  // A handful of backups plus the odd abandoned upload: always one page.
  const listed = await env.BUCKET.list({ prefix: "lobby/" });
  const doomed = listed.objects.map((o) => o.key).filter((k) => !kept.has(k) && revOfKey(k) <= latestRev);
  if (dropped.length) await env.DB.prepare("DELETE FROM lobby_backups WHERE rev <= ?").bind(dropped[0]!.rev).run();
  if (doomed.length) await env.BUCKET.delete(doomed);
}
```

- [ ] **Step 5: Add the routes**

In `apps/worker/src/routes/lobby.ts`, extend the imports:

```ts
import {
  LobbyClaimRequestSchema,
  LobbyCommitRequestSchema,
  LobbyUploadUrlRequestSchema,
  SessionRequestSchema,
  type CommitResponse,
  type LobbyClaimResponse,
  type LobbyLatestResponse,
  type LobbyPollResponse,
  type Ok,
  type UploadTarget,
} from "@mc/protocol";
import { beginLobbyUpload, commitLobbyBackup, latestBackup } from "../lobby-backups";
import { storageFor } from "../storage";
```

and append:

```ts
lobby.post("/backup/upload-url", async (c) => {
  const req = await readBody(c, LobbyUploadUrlRequestSchema);
  const body: UploadTarget = await beginLobbyUpload(c.env, c.req.url, req);
  return c.json(body);
});

lobby.post("/backup/commit", async (c) => {
  const req = await readBody(c, LobbyCommitRequestSchema);
  await commitLobbyBackup(c.env, { ...req, now: Date.now() });
  const body: CommitResponse = { rev: req.rev };
  return c.json(body);
});

lobby.get("/backup/latest", async (c) => {
  const row = await latestBackup(c.env.DB);
  const body: LobbyLatestResponse = {
    latest: row ? { rev: row.rev, sha256: row.sha256, size: row.size, url: await storageFor(c.env, c.req.url).getUrl(row.r2_key) } : null,
  };
  return c.json(body);
});
```

- [ ] **Step 6: Run all Worker tests**

Run: `bun run --cwd apps/worker test && bun run typecheck`
Expected: PASS. The snapshot tests still see the same error messages.

- [ ] **Step 7: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): lobby backups in R2, keeping the last 3"
```

---

### Task 5: Worker, the lobby in the manifest, `/status` and `/join`

**Files:**
- Modify: `apps/worker/src/routes/agent.ts`
- Modify: `apps/worker/src/commands/status.ts`
- Modify: `apps/worker/src/commands/join.ts`
- Modify: `apps/worker/test/agent.vitest.ts`
- Modify: `apps/worker/test/info-commands.vitest.ts`

**Interfaces:**
- Consumes: `lobbyAddress`, `LOBBY_NAME` (Task 3); `lobbyUp` helper (Task 2).
- Produces: `Manifest.lobby` filled in by the Worker; Discord text (exact strings in the tests below).

- [ ] **Step 1: Write the failing tests**

In `apps/worker/test/agent.vitest.ts`, add `lobbyUp` to the helpers import and this test inside `describe("GET /agent/manifest")`:

```ts
  it("names the lobby while it's up", async () => {
    await makeWorld();
    await lobbyUp("100.64.0.50");
    expect((await call("GET", "/agent/manifest", { token: alex })).body.lobby).toEqual({ address: "100.64.0.50" });
  });
```

In `apps/worker/test/info-commands.vitest.ts`, add `lobbyUp` to the helpers import and append:

```ts
describe("the lobby in /status and /join", () => {
  it("/status shows the lobby, or the direct address when the lobby is down", async () => {
    await addWorld("w1");
    await hostNow();
    expect(await content("status")).toContain("Lobby: ⚫ down, so connect straight to `100.64.0.3:25565`.");
    await lobbyUp("100.64.0.50");
    expect(await content("status")).toContain("Lobby: 🟢 up. Connect to `mc-lobby` and it sends you to whoever is hosting.");
  });

  it("a lobby that stopped polling counts as down", async () => {
    await addWorld("w1");
    await lobbyUp("100.64.0.50", Date.now() - 1);
    expect(await content("status")).toContain("Lobby: ⚫ down.");
  });

  it("/join points at mc-lobby, with its address as a fallback", async () => {
    await addWorld("w1");
    await lobbyUp("100.64.0.50");
    const s = await content("join");
    expect(s).toContain("3. Add a server with the address `mc-lobby` (once). It sends you to whoever is hosting. If that name doesn't connect, use `100.64.0.50`.");
  });

  it("/join gives the host's address when the lobby is down", async () => {
    await addWorld("w1");
    await hostNow();
    expect(await content("join")).toContain("3. The lobby is down, so connect straight to `100.64.0.3:25565`.");
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun run --cwd apps/worker test -- agent info-commands`
Expected: FAIL. The manifest has `lobby: null`, and the Discord text has no lobby lines.

- [ ] **Step 3: Fill in the manifest**

In `apps/worker/src/routes/agent.ts`, add `import { lobbyAddress } from "../lobby";` and replace `lobby: null,` with:

```ts
    lobby: await lobbyAddress(db, Date.now()),
```

- [ ] **Step 4: `/status`**

Replace the body of `run` in `apps/worker/src/commands/status.ts` from `const lease = …` onward:

```ts
    const lease = await readLease(c.env.DB);
    const lobby = await lobbyAddress(c.env.DB, c.now);
    const saved = latest
      ? `Last saved ${ago(c.now - latest.created_at)} by ${savedBy(latest.uploaded_by)} (rev ${latest.rev}).`
      : "It hasn't been saved yet.";
    const lobbyLine = lobby ? `Lobby: 🟢 up. Connect to \`${LOBBY_NAME}\` and it sends you to whoever is hosting.` : "Lobby: ⚫ down.";
    if (isHeld(lease, c.now) && lease.world_id === world.id) {
      const direct = `${lease.host_address}:${GAME_PORT}`;
      return reply(
        [
          `🟢 ${mention(lease.holder_id!)} is hosting **${world.name}** (${world.mc_version}) at \`${direct}\`.`,
          `Hosting for ${duration(c.now - (lease.claimed_at ?? c.now))}. ${saved}`,
          lobby ? lobbyLine : `Lobby: ⚫ down, so connect straight to \`${direct}\`.`,
        ].join("\n"),
      );
    }
    return reply(
      [
        `Nobody is hosting **${world.name}** (${world.mc_version}) right now.`,
        saved,
        "Anyone with mc-host can start it with `mc-host start`.",
        lobbyLine,
      ].join("\n"),
    );
```

Add `import { LOBBY_NAME, lobbyAddress } from "../lobby";`.

- [ ] **Step 5: `/join`**

In `apps/worker/src/commands/join.ts`, add `import { LOBBY_NAME, lobbyAddress } from "../lobby";` and replace the `const address = …` expression:

```ts
    const lobby = await lobbyAddress(c.env.DB, c.now);
    const hosting = isHeld(lease, c.now) && lease.world_id === world.id;
    const address = lobby
      ? `Add a server with the address \`${LOBBY_NAME}\` (once). It sends you to whoever is hosting. If that name doesn't connect, use \`${lobby.address}\`.`
      : hosting
        ? `The lobby is down, so connect straight to \`${lease.host_address}:${GAME_PORT}\`.`
        : "Nobody is hosting right now. `/status` shows the address once someone starts.";
```

- [ ] **Step 6: Run all Worker tests**

Run: `bun run --cwd apps/worker test && bun run typecheck`
Expected: PASS. The older `/status` and `/join` tests still match, because they use `toContain` on lines that didn't change.

- [ ] **Step 7: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): show the lobby in the manifest, /status and /join"
```

---

### Task 6: Agent, lobby API client and admin commands

**Files:**
- Modify: `apps/agent/src/host/api.ts`
- Modify: `apps/agent/src/cli.ts`
- Modify: `apps/agent/src/admin.ts`
- Modify: `apps/agent/src/commands.ts`
- Modify: `apps/agent/test/api.test.ts`
- Modify: `apps/agent/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas; Worker routes from Tasks 2–4.
- Produces:
  ```ts
  export interface LobbyApi {
    claim(req: LobbyClaimRequest): Promise<LobbyClaimResponse>;
    poll(sessionId: string): Promise<LobbyPollResponse>;
    release(sessionId: string): Promise<void>;
    backupUrl(req: LobbyUploadUrlRequest): Promise<UploadTarget>;
    /** Returns the committed rev. */
    commitBackup(req: LobbyCommitRequest): Promise<number>;
    latestBackup(): Promise<SnapshotRef | null>;
  }
  export function createLobbyApi(o: { workerUrl: string; token: string; fetch: Fetch }): LobbyApi;
  // AdminApi gains:
  mintLobbyToken(name: string): Promise<string>;
  releaseLobby(): Promise<{ machine: string; address: string } | null>;
  ```
  - CLI kinds `{ kind: "admin-lobby-token"; name: string }` and `{ kind: "admin-lobby-release" }`

- [ ] **Step 1: Write the failing tests**

Append to `apps/agent/test/api.test.ts` and add `createLobbyApi` to its `../src/host/api` import:

```ts
test("the lobby client uses /lobby routes, and a refusal becomes a plain message", async () => {
  const refused = "The lobby is already running on pi (heard from it just now). Stop it there first, or run `mc-host admin lobby release`.";
  const { fetch, seen } = fakeFetch((url) =>
    url.endsWith("/lobby/claim") ? json({ error: "lease_held", message: refused }, 409) : json({ host: null, expiresAt: 5 }),
  );
  const api = createLobbyApi({ workerUrl: "https://w.test/", token: "tok", fetch });
  expect(await api.poll("s".repeat(16))).toEqual({ host: null, expiresAt: 5 });
  expect(seen[0]).toMatchObject({ url: "https://w.test/lobby/poll", method: "POST", auth: "Bearer tok", body: { sessionId: "s".repeat(16) } });
  await expect(api.claim({ address: "100.64.0.50", machine: "fedora" })).rejects.toThrow(refused);
});
```

Append to `apps/agent/test/cli.test.ts`:

```ts
test("parses the lobby admin commands", () => {
  expect(parseCommand(["admin", "lobby", "token", "fedora"])).toEqual({ kind: "admin-lobby-token", name: "fedora" });
  expect(parseCommand(["admin", "lobby", "release"])).toEqual({ kind: "admin-lobby-release" });
  expect(() => parseCommand(["admin", "lobby", "token"])).toThrow(/Missing <name>/);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/api.test.ts apps/agent/test/cli.test.ts`
Expected: FAIL, `createLobbyApi` isn't exported, and `admin lobby` is an unknown command.

- [ ] **Step 3: Add the client**

In `apps/agent/src/host/api.ts`, add to the `@mc/protocol` import: `LobbyClaimResponseSchema`, `LobbyLatestResponseSchema`, `LobbyPollResponseSchema`, `LobbyReleaseResponseSchema`, `type LobbyClaimRequest`, `type LobbyClaimResponse`, `type LobbyCommitRequest`, `type LobbyPollResponse`, `type LobbyUploadUrlRequest`, `type SnapshotRef`. Append:

```ts
export interface LobbyApi {
  claim(req: LobbyClaimRequest): Promise<LobbyClaimResponse>;
  poll(sessionId: string): Promise<LobbyPollResponse>;
  release(sessionId: string): Promise<void>;
  backupUrl(req: LobbyUploadUrlRequest): Promise<UploadTarget>;
  /** Returns the committed rev. */
  commitBackup(req: LobbyCommitRequest): Promise<number>;
  latestBackup(): Promise<SnapshotRef | null>;
}

export function createLobbyApi(o: { workerUrl: string; token: string; fetch: Fetch }): LobbyApi {
  const c: Client = { fetch: o.fetch, base: o.workerUrl.replace(/\/+$/, ""), secret: o.token };
  return {
    claim: (req) => request(c, "POST", "/lobby/claim", LobbyClaimResponseSchema, req),
    poll: (sessionId) => request(c, "POST", "/lobby/poll", LobbyPollResponseSchema, { sessionId }),
    release: async (sessionId) => {
      await request(c, "POST", "/lobby/release", OkSchema, { sessionId });
    },
    backupUrl: (req) => request(c, "POST", "/lobby/backup/upload-url", UploadTargetSchema, req),
    commitBackup: async (req) => (await request(c, "POST", "/lobby/backup/commit", CommitResponseSchema, req)).rev,
    latestBackup: async () => (await request(c, "GET", "/lobby/backup/latest", LobbyLatestResponseSchema)).latest,
  };
}
```

Add to `interface AdminApi`:

```ts
  mintLobbyToken(name: string): Promise<string>;
  /** Who held the lobby slot, or null if no lobby was running. */
  releaseLobby(): Promise<{ machine: string; address: string } | null>;
```

and to the object returned by `createAdminApi`:

```ts
    mintLobbyToken: async (name) => (await request(c, "POST", "/admin/lobby/token", MintTokenResponseSchema, { name })).token,
    releaseLobby: async () => (await request(c, "POST", "/admin/lobby/release", LobbyReleaseResponseSchema, {})).released,
```

- [ ] **Step 4: Add the admin commands**

In `apps/agent/src/cli.ts`:
- Add `| { kind: "admin-lobby-token"; name: string }` and `| { kind: "admin-lobby-release" }` to `Command`.
- In `USAGE`, after the `admin status` entry:
  ```
    admin lobby token <name>
        Print a token for the lobby server on the machine called <name> (fedora, pi …).
    admin lobby release
        Free the lobby slot when a lobby machine died without stopping.
  ```
- In the `admin` case, before `throw unknown(["admin", sub, a]);`:
  ```ts
      if (sub === "lobby" && a === "token") return { kind: "admin-lobby-token", name: need(b, "<name>") };
      if (sub === "lobby" && a === "release") return { kind: "admin-lobby-release" };
  ```

In `apps/agent/src/admin.ts`, add `"admin-lobby-token" | "admin-lobby-release"` to the `AdminCommand` kind union, and add these cases to `runAdmin`'s switch:

```ts
    case "admin-lobby-token": {
      const token = await api.mintLobbyToken(cmd.name);
      deps.log(`Lobby token for ${cmd.name}: ${token}`);
      deps.log("It's shown only once. Pass it to scripts/install-lobby.sh --token. Minting again replaces it.");
      return;
    }
    case "admin-lobby-release": {
      const released = await api.releaseLobby();
      deps.log(released ? `Released the lobby slot (${released.machine} held it at ${released.address}).` : "No lobby was running.");
      return;
    }
```

In `apps/agent/src/commands.ts`, add `case "admin-lobby-token":` and `case "admin-lobby-release":` to the list of cases that `return runAdmin(cmd, deps);`.

- [ ] **Step 5: Run the tests**

Run: `bun test apps/agent && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): lobby API client and admin lobby token|release"
```

---

### Task 7: Agent, generic zips and the lobby folder

**Files:**
- Modify: `apps/agent/src/host/snapshot.ts`
- Create: `apps/agent/src/lobby/folder.ts`
- Create: `apps/agent/test/lobby-folder.test.ts`

**Interfaces:**
- Produces (`host/snapshot.ts`):
  - `zipTree(root: string, tops: string[], outFile: string, skip?: (rel: string) => boolean): Promise<{ sha256: string; size: number }>`
  - `extractZip(zipFile, destDir, expectedSha256, o: { what: string; allowTop: (top: string) => boolean; clear: () => Promise<void> }): Promise<void>`. It throws `ChecksumError` with `The downloaded ${what} is damaged (its sha256 doesn't match).`
  - `zipSnapshot` and `extractSnapshot` keep their signatures and messages.
- Produces (`lobby/folder.ts`):
  - `lobbyRoot(dataDir)` = `<dataDir>/lobby`, `lobbyServerDir(dataDir)` = `<dataDir>/lobby/server`
  - `NOT_BACKED_UP: string[]`, `notBackedUp(rel): boolean`
  - `zipLobby(dir, outFile)`, `restoreLobby(zipFile, dir, sha256)`
  - `interface LobbyState { sessionId?: string; backupRev: number }`, `readLobbyState(dataDir)`, `writeLobbyState(dataDir, state)`
  - `moveLobbyAside(dataDir, now): Promise<string | null>` (to `<dataDir>/lobby/old-<stamp>`)

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/lobby-folder.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChecksumError } from "../src/host/snapshot";
import { lobbyRoot, lobbyServerDir, moveLobbyAside, readLobbyState, restoreLobby, writeLobbyState, zipLobby } from "../src/lobby/folder";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-lobby-folder-"));
});

function put(dir: string, rel: string, data: string) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), data);
}

function listAll(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listAll(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}

function lobbyFolder(dir: string) {
  put(dir, "world/level.dat", "level");
  put(dir, "world/session.lock", "locked");
  put(dir, "plugins/WorldEdit.jar", "worldedit");
  put(dir, "plugins/WorldEdit/config.yml", "wand: wooden_axe");
  put(dir, "plugins/.paper-remapped/WorldEdit.jar", "remapped");
  put(dir, "plugins/lobby-bridge.jar", "bridge");
  put(dir, "server.properties", "motd=Lobby");
  put(dir, "cache/mojang_26.3.jar", "vanilla");
  put(dir, "libraries/com/x.jar", "lib");
  put(dir, "versions/26.3/paper.jar", "patched");
  put(dir, "logs/latest.log", "log");
  put(dir, "paper.jar", "paper");
}

test("a backup leaves out what Paper downloads again, and restores into a clean folder", async () => {
  const src = join(root, "src");
  lobbyFolder(src);
  const zip = join(root, "backup.zip");
  const z = await zipLobby(src, zip);
  const dest = join(root, "restored");
  put(dest, "stale.txt", "from before");
  await restoreLobby(zip, dest, z.sha256);
  expect(listAll(dest)).toEqual(["plugins/WorldEdit.jar", "plugins/WorldEdit/config.yml", "server.properties", "world/level.dat"]);
});

test("a damaged backup is refused before anything is touched", async () => {
  const src = join(root, "src");
  lobbyFolder(src);
  const zip = join(root, "backup.zip");
  await zipLobby(src, zip);
  const dest = join(root, "restored");
  put(dest, "stale.txt", "from before");
  await expect(restoreLobby(zip, dest, "0".repeat(64))).rejects.toBeInstanceOf(ChecksumError);
  await expect(restoreLobby(zip, dest, "0".repeat(64))).rejects.toThrow("The downloaded lobby backup is damaged");
  expect(readFileSync(join(dest, "stale.txt"), "utf8")).toBe("from before");
});

test("lobby state starts at rev 0 and round-trips", async () => {
  expect(await readLobbyState(root)).toEqual({ backupRev: 0 });
  await writeLobbyState(root, { sessionId: "lobby-session-0123456789", backupRev: 4 });
  expect(await readLobbyState(root)).toEqual({ sessionId: "lobby-session-0123456789", backupRev: 4 });
});

test("moving the lobby aside keeps it under lobby/old-<stamp>", async () => {
  expect(await moveLobbyAside(root, 0)).toBeNull();
  put(lobbyServerDir(root), "server.properties", "motd=Old");
  const dest = await moveLobbyAside(root, new Date(2026, 9, 3, 21, 5, 9).getTime());
  expect(dest).toBe(join(lobbyRoot(root), "old-2026-10-03_21-05-09"));
  expect(readFileSync(join(dest!, "server.properties"), "utf8")).toBe("motd=Old");
  expect(existsSync(lobbyServerDir(root))).toBe(false);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/lobby-folder.test.ts`
Expected: FAIL, `../src/lobby/folder` doesn't exist.

- [ ] **Step 3: Make zipping and unzipping generic**

In `apps/agent/src/host/snapshot.ts`, rename the body of `zipSnapshot` into `zipTree`, and keep `zipSnapshot` as a wrapper:

```ts
/** Stream every file under `tops` (paths relative to root) into outFile. Never holds the whole zip in memory. */
export async function zipTree(
  root: string,
  tops: string[],
  outFile: string,
  skip: (rel: string) => boolean = () => false,
): Promise<{ sha256: string; size: number }> {
  // … the existing body of zipSnapshot, with two changes:
  //   for (const top of tops) {                       (was: snapshotPaths(levelName))
  //     for await (const rel of walk(root, top)) {    (was: walk(serverDir, top))
  //       if (SKIP.has(basename(rel)) || skip(rel)) continue;
  //       …Bun.file(join(root, rel))…                 (was: join(serverDir, rel))
}

/** Stream the snapshot paths of serverDir into outFile. Never holds the whole zip in memory. */
export async function zipSnapshot(serverDir: string, levelName: string, outFile: string): Promise<{ sha256: string; size: number }> {
  return zipTree(serverDir, snapshotPaths(levelName), outFile);
}
```

Replace `entryPath` and `extractSnapshot` with:

```ts
interface ExtractOptions {
  /** What the zip is, for messages: "world", "lobby backup". */
  what: string;
  /** Whether an entry may live under this first path segment. */
  allowTop: (top: string) => boolean;
  /** Runs after the checksum passes and before anything is written. */
  clear: () => Promise<void>;
}

/** Directory entries return null; unsafe paths and disallowed top-level names are refused. */
function entryPath(name: string, o: ExtractOptions): string | null {
  if (name.endsWith("/")) return null;
  const parts = name.split("/");
  const unsafe = parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\") || p.includes(":")) || !o.allowTop(parts[0]!);
  if (unsafe) throw new UserError(`The ${o.what} download contains an unsafe path ("${name}"), so it wasn't unpacked. Tell a maintainer.`);
  return name;
}

/** Check the sha256 first; only then clear and unpack the zip into destDir. */
export async function extractZip(zipFile: string, destDir: string, expectedSha256: string, o: ExtractOptions): Promise<void> {
  if ((await sha256File(zipFile)) !== expectedSha256) {
    throw new ChecksumError(`The downloaded ${o.what} is damaged (its sha256 doesn't match).`);
  }
  await o.clear();
  await mkdir(destDir, { recursive: true });
  // … the existing unzip loop from extractSnapshot, with `serverDir` renamed to `destDir`
  // and `entryPath(file.name, levelName)` changed to `entryPath(file.name, o)`.
}

/** Check the sha256 first; only then replace the snapshot paths in serverDir with the zip's contents. */
export async function extractSnapshot(zipFile: string, serverDir: string, levelName: string, expectedSha256: string): Promise<void> {
  return extractZip(zipFile, serverDir, expectedSha256, {
    what: "world",
    allowTop: (top) => snapshotPaths(levelName).includes(top),
    clear: () => clearSnapshotPaths(serverDir, levelName),
  });
}
```

Run `bun test apps/agent/test/snapshot.test.ts` now. Expected: PASS, since the world wrappers behave exactly as before.

- [ ] **Step 4: Write `apps/agent/src/lobby/folder.ts`**

```ts
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { extractZip, zipTree } from "../host/snapshot";
import { stamp } from "../host/state";

export const lobbyRoot = (dataDir: string) => join(dataDir, "lobby");
export const lobbyServerDir = (dataDir: string) => join(lobbyRoot(dataDir), "server");

/** Downloaded again or rebuilt by Paper on every start, so never backed up. */
export const NOT_BACKED_UP = [
  "cache",
  "libraries",
  "versions",
  "logs",
  "crash-reports",
  "paper.jar",
  "plugins/.paper-remapped",
  "plugins/lobby-bridge.jar",
];
export const notBackedUp = (rel: string): boolean => NOT_BACKED_UP.some((p) => rel === p || rel.startsWith(`${p}/`));

export async function zipLobby(dir: string, outFile: string): Promise<{ sha256: string; size: number }> {
  const tops = (await readdir(dir)).filter((name) => !notBackedUp(name)).sort();
  return zipTree(dir, tops, outFile, notBackedUp);
}

/** Replace dir with the backup's contents, once its sha256 checks out. */
export async function restoreLobby(zipFile: string, dir: string, sha256: string): Promise<void> {
  await extractZip(zipFile, dir, sha256, {
    what: "lobby backup",
    allowTop: (top) => !notBackedUp(top),
    clear: () => rm(dir, { recursive: true, force: true }),
  });
}

/** `sessionId`: this machine's last lobby session. `backupRev`: the backup this folder was restored from or last saved as. */
export interface LobbyState {
  sessionId?: string;
  backupRev: number;
}

const statePath = (dataDir: string) => join(lobbyRoot(dataDir), "state.json");

export async function readLobbyState(dataDir: string): Promise<LobbyState> {
  const path = statePath(dataDir);
  if (!existsSync(path)) return { backupRev: 0 };
  try {
    return JSON.parse(await readFile(path, "utf8")) as LobbyState;
  } catch {
    throw new UserError(`${path} is damaged. Delete it, then start the lobby again.`);
  }
}

/** Write via a temp file and rename, so a crash mid-write never leaves half a file. */
export async function writeLobbyState(dataDir: string, state: LobbyState): Promise<void> {
  await mkdir(lobbyRoot(dataDir), { recursive: true });
  const path = statePath(dataDir);
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

/** Move this machine's lobby folder to lobby/old-<stamp>. Returns null when there was none. */
export async function moveLobbyAside(dataDir: string, now: number): Promise<string | null> {
  const src = lobbyServerDir(dataDir);
  if (!existsSync(src)) return null;
  const dest = join(lobbyRoot(dataDir), `old-${stamp(now)}`);
  await rename(src, dest);
  return dest;
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test apps/agent && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): lobby backup zips, restore and local state"
```

---

### Task 8: Agent, Paper, the plugin jar and a fresh lobby

**Files:**
- Create: `apps/agent/src/lobby/paper.ts`
- Create: `apps/agent/test/lobby-paper.test.ts`

**Interfaces:**
- Consumes: `fetchVerified` (`src/download.ts`), `sha256File` (`host/snapshot.ts`), `mergeProperties` (`server/properties.ts`).
- Produces:
  - `PAPER: { minecraft: "26.3"; javaMajor: 25; build: 147; url: string; sha256: string }`, `type PaperBuild = typeof PAPER`
  - `PAPER_JAR = "paper.jar"`, `BRIDGE_JAR = "lobby-bridge.jar"`, `LOBBY_PROPERTIES`
  - `installPaper(dir, o: { fetch; cacheDir; userAgent; paper?: PaperBuild }): Promise<void>`
  - `installBridge(dir, jar: string | undefined): Promise<void>`
  - `writeFreshProperties(dir): Promise<boolean>` (true when it wrote the file)
  - `paperCommand(javaBin): string[]`

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/lobby-paper.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, type Fetch } from "@mc/profile";
import { installBridge, installPaper, PAPER, paperCommand, writeFreshProperties } from "../src/lobby/paper";

let dir: string;
let cacheDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-lobby-paper-"));
  cacheDir = mkdtempSync(join(tmpdir(), "mc-lobby-cache-"));
});
const served = new TextEncoder().encode("paper jar");
const fetch: Fetch = async () => new Response(served);

test("installs Paper after checking its sha256", async () => {
  const paper = { ...PAPER, url: "https://p.test/paper-ok.jar", sha256: await sha256Hex(served) };
  await installPaper(dir, { fetch, cacheDir, userAgent: "test", paper });
  expect(readFileSync(join(dir, "paper.jar"), "utf8")).toBe("paper jar");
});

test("refuses a Paper download whose sha256 doesn't match", async () => {
  const paper = { ...PAPER, url: "https://p.test/paper-bad.jar", sha256: "0".repeat(64) };
  await expect(installPaper(dir, { fetch, cacheDir, userAgent: "test", paper })).rejects.toThrow(
    "The Paper 26.3 download is damaged (its sha256 doesn't match). Start the lobby again to retry.",
  );
  expect(existsSync(join(dir, "paper.jar"))).toBe(false);
});

test("copies the bridge plugin, and says how to fix a missing one", async () => {
  const jar = join(cacheDir, "lobby-bridge.jar");
  writeFileSync(jar, "bridge");
  await installBridge(dir, jar);
  expect(readFileSync(join(dir, "plugins", "lobby-bridge.jar"), "utf8")).toBe("bridge");
  await expect(installBridge(dir, undefined)).rejects.toThrow("The lobby-bridge plugin is missing.");
  await expect(installBridge(dir, join(cacheDir, "nope.jar"))).rejects.toThrow("MC_LOBBY_BRIDGE_JAR");
});

test("a new lobby gets superflat adventure properties once; after that the file is the maintainer's", async () => {
  expect(await writeFreshProperties(dir)).toBe(true);
  const text = readFileSync(join(dir, "server.properties"), "utf8");
  expect(text).toContain("level-type=minecraft:flat");
  expect(text).toContain("gamemode=adventure");
  writeFileSync(join(dir, "server.properties"), "motd=Mine\n");
  expect(await writeFreshProperties(dir)).toBe(false);
  expect(readFileSync(join(dir, "server.properties"), "utf8")).toBe("motd=Mine\n");
});

test("Paper starts without its GUI", () => {
  expect(paperCommand("/jre/bin/java")).toEqual(["/jre/bin/java", "-Xms512M", "-Xmx1536M", "-jar", "paper.jar", "--nogui"]);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/lobby-paper.test.ts`
Expected: FAIL, `../src/lobby/paper` doesn't exist.

- [ ] **Step 3: Write `apps/agent/src/lobby/paper.ts`**

```ts
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError, type Fetch } from "@mc/profile";
import { fetchVerified } from "../download";
import { sha256File } from "../host/snapshot";
import { mergeProperties } from "../server/properties";

/**
 * The Paper build the lobby runs, from https://fill.papermc.io/v3/projects/paper/versions/26.3/builds.
 * 26.3 has only beta builds so far; move to a stable one when it ships.
 */
export const PAPER = {
  minecraft: "26.3",
  javaMajor: 25,
  build: 147,
  url: "https://fill-data.papermc.io/v1/objects/e88207b474f1954f4de175a0b63a3d574e995f609d7fd9c4960d4f76e1784ae3/paper-26.3-147.jar",
  sha256: "e88207b474f1954f4de175a0b63a3d574e995f609d7fd9c4960d4f76e1784ae3",
};
export type PaperBuild = typeof PAPER;

export const PAPER_JAR = "paper.jar";
export const BRIDGE_JAR = "lobby-bridge.jar";

/** Only written for a lobby with no server.properties yet; after that the file is the maintainer's. */
export const LOBBY_PROPERTIES: Record<string, string | number | boolean> = {
  motd: "Lobby: /play joins whoever is hosting",
  "level-type": "minecraft:flat",
  "generate-structures": false,
  gamemode: "adventure",
  difficulty: "peaceful",
  "spawn-protection": 0,
  "max-players": 20,
};

export async function installPaper(dir: string, o: { fetch: Fetch; cacheDir: string; userAgent: string; paper?: PaperBuild }): Promise<void> {
  const paper = o.paper ?? PAPER;
  const cached = await fetchVerified(paper.url, undefined, {
    fetch: o.fetch,
    cacheDir: o.cacheDir,
    userAgent: o.userAgent,
    label: `Paper ${paper.minecraft} build ${paper.build}`,
  });
  if ((await sha256File(cached)) !== paper.sha256) {
    await rm(cached, { force: true });
    throw new UserError(`The Paper ${paper.minecraft} download is damaged (its sha256 doesn't match). Start the lobby again to retry.`);
  }
  await mkdir(dir, { recursive: true });
  await copyFile(cached, join(dir, PAPER_JAR));
}

/** The plugin is built by scripts/install-lobby.sh and baked into the image (MC_LOBBY_BRIDGE_JAR). */
export async function installBridge(dir: string, jar: string | undefined): Promise<void> {
  if (!jar || !existsSync(jar)) {
    throw new UserError(
      "The lobby-bridge plugin is missing. Run scripts/install-lobby.sh again, or point MC_LOBBY_BRIDGE_JAR at lobby-bridge.jar.",
    );
  }
  await mkdir(join(dir, "plugins"), { recursive: true });
  await copyFile(jar, join(dir, "plugins", BRIDGE_JAR));
}

export async function writeFreshProperties(dir: string): Promise<boolean> {
  const path = join(dir, "server.properties");
  if (existsSync(path)) return false;
  await mkdir(dir, { recursive: true });
  await writeFile(path, mergeProperties("", LOBBY_PROPERTIES));
  return true;
}

export const paperCommand = (javaBin: string): string[] => [javaBin, "-Xms512M", "-Xmx1536M", "-jar", PAPER_JAR, "--nogui"];
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/agent/test/lobby-paper.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): pinned Paper 26.3, the bridge plugin and fresh lobby settings"
```

---

### Task 9: Agent, the lobby runner

**Files:**
- Create: `apps/agent/src/lobby/bridge.ts`
- Create: `apps/agent/src/lobby/run.ts`
- Create: `apps/agent/test/lobby-fakes.ts`
- Create: `apps/agent/test/lobby-run.test.ts`

**Interfaces:**
- Consumes: `LobbyApi` (Task 6); `lobbyServerDir`, `lobbyRoot`, `readLobbyState`, `writeLobbyState`, `moveLobbyAside`, `restoreLobby`, `zipLobby` (Task 7); `ServerConsole`, `ServerProcess` (`host/console.ts`); `Timers`, `SAVE_TIMEOUT_MS`, `UPLOAD_ATTEMPTS`, `DOWNLOAD_ATTEMPTS`, `mb` (`host/deps.ts`); `LeaseLostError`, `StaleRevError`, `OfflineError` (`host/api.ts`); `ChecksumError` (`host/snapshot.ts`); `tmpDirFor` (`host/state.ts`).
- Produces:
  - `bridgeCommand(host: LobbyHost | null): string`, `GAME_PORT = 25565` (`lobby/bridge.ts`)
  - `POLL_MS = 5_000`, `LOBBY_BACKUP_MS = 1_800_000`, `interface LobbyDeps`, `runLobby(deps: LobbyDeps): Promise<void>` (`lobby/run.ts`)

- [ ] **Step 1: Write the fakes**

`apps/agent/test/lobby-fakes.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LobbyClaimRequest, LobbyClaimResponse, LobbyCommitRequest, LobbyHost, LobbyPollResponse, SnapshotRef, UploadTarget } from "@mc/protocol";
import type { LobbyApi } from "../src/host/api";
import { zipLobby } from "../src/lobby/folder";
import type { LobbyDeps } from "../src/lobby/run";
import { FakeServer, ManualTimers, StopSignal } from "./host-fakes";

export const LOBBY_SESSION = "lobby-session-0123456789";

export class FakeLobbyApi implements LobbyApi {
  latest: SnapshotRef | null = null;
  host: LobbyHost | null = null;
  claims: LobbyClaimRequest[] = [];
  /** Each call takes the next error, if any. */
  claimErrors: Error[] = [];
  pollErrors: Error[] = [];
  commits: LobbyCommitRequest[] = [];
  private sessions = 0;

  constructor(private events: string[]) {}

  async claim(req: LobbyClaimRequest): Promise<LobbyClaimResponse> {
    this.events.push(`api:claim ${req.machine}`);
    this.claims.push(req);
    const err = this.claimErrors.shift();
    if (err) throw err;
    this.sessions++;
    return { sessionId: `${LOBBY_SESSION}-${this.sessions}`, expiresAt: 0 };
  }
  async poll(sessionId: string): Promise<LobbyPollResponse> {
    this.events.push(`api:poll ${sessionId}`);
    const err = this.pollErrors.shift();
    if (err) throw err;
    return { host: this.host, expiresAt: 0 };
  }
  async release(sessionId: string): Promise<void> {
    this.events.push(`api:release ${sessionId}`);
  }
  async backupUrl(): Promise<UploadTarget> {
    const rev = (this.latest?.rev ?? 0) + 1;
    this.events.push("api:backupUrl");
    return { rev, key: `lobby/${rev}-k.zip`, url: "https://r2.test/put", headers: {} };
  }
  async commitBackup(req: LobbyCommitRequest): Promise<number> {
    this.events.push(`api:commitBackup ${req.rev}`);
    this.commits.push(req);
    this.latest = { rev: req.rev, sha256: req.sha256, size: req.size, url: `https://r2.test/lobby${req.rev}.zip` };
    return req.rev;
  }
  async latestBackup(): Promise<SnapshotRef | null> {
    this.events.push("api:latestBackup");
    return this.latest;
  }
}

export interface LobbyHarness {
  deps: LobbyDeps;
  api: FakeLobbyApi;
  events: string[];
  logs: string[];
  timers: ManualTimers;
  stop: StopSignal;
  servers: FakeServer[];
  exits: number[];
}

export function makeLobbyHarness(o: { fixtureZip?: string; fresh?: boolean } = {}): LobbyHarness {
  const events: string[] = [];
  const h: Omit<LobbyHarness, "deps"> = {
    api: new FakeLobbyApi(events),
    events,
    logs: [],
    timers: new ManualTimers(),
    stop: new StopSignal(),
    servers: [],
    exits: [],
  };
  const deps: LobbyDeps = {
    api: h.api,
    dataDir: mkdtempSync(join(tmpdir(), "mc-lobby-")),
    log: (line) => h.logs.push(line),
    address: () => "100.64.0.50",
    machine: "fedora",
    fresh: o.fresh ?? false,
    prepareServer: async (dir) => {
      events.push("prepare");
      mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, "server.properties"))) writeFileSync(join(dir, "server.properties"), "motd=Lobby\n");
    },
    ensureJava: async () => "/jre/bin/java",
    launch: () => {
      const s = new FakeServer(undefined, events);
      h.servers.push(s);
      return s;
    },
    forwardInput: () => {},
    download: async (url, dest) => {
      events.push(`download ${url}`);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(o.fixtureZip!, dest);
    },
    upload: async (target) => {
      events.push(`upload ${target.url}`);
    },
    onStopSignal: h.stop.on,
    crashSummary: async () => "Last 30 lines of logs/latest.log:\nboom",
    now: () => new Date(2026, 9, 3, 21, 0).getTime(),
    sleep: async () => {},
    timers: h.timers,
    exit: (code) => {
      h.exits.push(code);
    },
  };
  return { ...h, deps };
}

/** A zipped lobby folder: what a backup download delivers. */
export async function lobbyFixture(content = "from the backup") {
  const root = mkdtempSync(join(tmpdir(), "mc-lobby-fixture-"));
  const src = join(root, "src");
  mkdirSync(join(src, "world"), { recursive: true });
  writeFileSync(join(src, "world", "level.dat"), content);
  writeFileSync(join(src, "server.properties"), "motd=Backed up\n");
  const zip = join(root, "fixture.zip");
  return { zip, ...(await zipLobby(src, zip)) };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/agent/test/lobby-run.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { LeaseLostError, OfflineError } from "../src/host/api";
import { bridgeCommand } from "../src/lobby/bridge";
import { lobbyRoot, lobbyServerDir, readLobbyState, writeLobbyState } from "../src/lobby/folder";
import { LOBBY_BACKUP_MS, POLL_MS, runLobby } from "../src/lobby/run";
import { DONE_LINE, until } from "./host-fakes";
import { LOBBY_SESSION, lobbyFixture, makeLobbyHarness } from "./lobby-fakes";

const ALEX = { name: "Alex", address: "100.64.0.3", world: "adventure", minecraft: "26.3" };
const polls = (events: string[]) => events.filter((e) => e.startsWith("api:poll")).length;

async function running(o: Parameters<typeof makeLobbyHarness>[0] = {}) {
  const h = makeLobbyHarness(o);
  const done = runLobby(h.deps);
  done.catch(() => {});
  await until(() => h.servers.length === 1);
  await until(() => polls(h.events) === 1);
  return { h, done, server: h.servers[0]! };
}

test("the plugin command keeps names with spaces in one piece", () => {
  expect(bridgeCommand(null)).toBe("lobbybridge none");
  expect(bridgeCommand({ ...ALEX, name: "Sam  the\tBuilder" })).toBe("lobbybridge host 100.64.0.3 25565 adventure Sam the Builder");
});

test("a first lobby: no backup, tells the plugin once per change, backs up and stops", async () => {
  const { h, done, server } = await running();
  expect(h.events.slice(0, 3)).toEqual(["api:claim fedora", "api:latestBackup", "prepare"]);
  expect(h.logs).toContain("There's no lobby backup yet, so this is a fresh lobby.");
  expect(server.written).toEqual([]);

  server.emit(DONE_LINE);
  expect(server.written).toEqual(["lobbybridge none"]);
  expect(h.logs).toContain("The lobby is up. Players connect to mc-lobby (100.64.0.50:25565).");

  h.api.host = ALEX;
  h.timers.fire(POLL_MS);
  await until(() => server.written.length === 2);
  expect(server.written[1]).toBe("lobbybridge host 100.64.0.3 25565 adventure Alex");
  h.timers.fire(POLL_MS);
  await until(() => polls(h.events) === 3);
  expect(server.written).toHaveLength(2);

  h.timers.fire(LOBBY_BACKUP_MS);
  await until(() => h.events.includes("api:commitBackup 1"));
  expect(server.written.slice(2)).toEqual(["save-off", "save-all flush", "save-on"]);

  h.stop.fire();
  await done;
  expect(server.written.at(-1)).toBe("stop");
  expect(h.events).toContain("api:commitBackup 2");
  expect(h.events.at(-1)).toBe(`api:release ${LOBBY_SESSION}-1`);
  expect(await readLobbyState(h.deps.dataDir)).toEqual({ sessionId: `${LOBBY_SESSION}-1`, backupRev: 2 });
  expect(h.logs.at(-1)).toBe("The lobby has stopped.");
});

test("a new machine restores the latest backup", async () => {
  const fx = await lobbyFixture();
  const h0 = makeLobbyHarness({ fixtureZip: fx.zip });
  h0.api.latest = { rev: 4, sha256: fx.sha256, size: fx.size, url: "https://r2.test/lobby4.zip" };
  const done = runLobby(h0.deps);
  await until(() => h0.servers.length === 1);
  expect(readFileSync(join(lobbyServerDir(h0.deps.dataDir), "world", "level.dat"), "utf8")).toBe("from the backup");
  expect(await readLobbyState(h0.deps.dataDir)).toMatchObject({ backupRev: 4 });
  h0.stop.fire();
  await done;
  expect(h0.events).toContain("api:commitBackup 5");
});

test("a machine whose lobby is older than the backup moves it aside and restores", async () => {
  const fx = await lobbyFixture();
  const h = makeLobbyHarness({ fixtureZip: fx.zip });
  const dir = lobbyServerDir(h.deps.dataDir);
  mkdirSync(join(dir, "world"), { recursive: true });
  writeFileSync(join(dir, "server.properties"), "motd=Old\n");
  writeFileSync(join(dir, "world", "level.dat"), "stale");
  await writeLobbyState(h.deps.dataDir, { backupRev: 2 });
  h.api.latest = { rev: 4, sha256: fx.sha256, size: fx.size, url: "https://r2.test/lobby4.zip" };
  const done = runLobby(h.deps);
  await until(() => h.servers.length === 1);
  expect(readFileSync(join(dir, "world", "level.dat"), "utf8")).toBe("from the backup");
  expect(h.logs.some((l) => l.startsWith("The lobby on this machine is older than the backup (rev 2, the backup is rev 4)"))).toBe(true);
  expect(readdirSync(lobbyRoot(h.deps.dataDir)).filter((n) => n.startsWith("old-"))).toHaveLength(1);
  h.stop.fire();
  await done;
});

test("a machine whose lobby matches the latest backup keeps it", async () => {
  const h = makeLobbyHarness();
  const dir = lobbyServerDir(h.deps.dataDir);
  mkdirSync(join(dir, "world"), { recursive: true });
  writeFileSync(join(dir, "server.properties"), "motd=Mine\n");
  writeFileSync(join(dir, "world", "level.dat"), "mine");
  await writeLobbyState(h.deps.dataDir, { backupRev: 4 });
  h.api.latest = { rev: 4, sha256: "a".repeat(64), size: 10, url: "https://r2.test/lobby4.zip" };
  const done = runLobby(h.deps);
  await until(() => h.servers.length === 1);
  expect(h.events.some((e) => e.startsWith("download"))).toBe(false);
  expect(readFileSync(join(dir, "world", "level.dat"), "utf8")).toBe("mine");
  h.stop.fire();
  await done;
});

test("a damaged backup stops the start, releases the slot and points at --fresh", async () => {
  const fx = await lobbyFixture();
  const h = makeLobbyHarness({ fixtureZip: fx.zip });
  h.api.latest = { rev: 3, sha256: "0".repeat(64), size: fx.size, url: "https://r2.test/lobby3.zip" };
  await expect(runLobby(h.deps)).rejects.toThrow(
    "Couldn't restore lobby backup rev 3: The downloaded lobby backup is damaged (its sha256 doesn't match). Run `mc-host lobby --fresh` to start an empty lobby instead.",
  );
  expect(h.events.filter((e) => e.startsWith("download"))).toHaveLength(3);
  expect(h.events.at(-1)).toBe(`api:release ${LOBBY_SESSION}-1`);
  expect(h.servers).toHaveLength(0);
  expect(h.stop.count).toBe(0);
});

test("--fresh ignores the backups and carries on numbering after them", async () => {
  const h = makeLobbyHarness({ fresh: true });
  h.api.latest = { rev: 3, sha256: "0".repeat(64), size: 10, url: "https://r2.test/lobby3.zip" };
  const done = runLobby(h.deps);
  await until(() => h.servers.length === 1);
  expect(h.events.some((e) => e.startsWith("download"))).toBe(false);
  expect(h.logs).toContain("Starting a fresh lobby.");
  h.stop.fire();
  await done;
  expect(h.events).toContain("api:commitBackup 4");
});

test("a restart on the same machine asks for its previous session", async () => {
  const h = makeLobbyHarness();
  await writeLobbyState(h.deps.dataDir, { sessionId: "lobby-session-old-0001", backupRev: 0 });
  const done = runLobby(h.deps);
  await until(() => h.servers.length === 1);
  expect(h.api.claims[0]).toEqual({ address: "100.64.0.50", machine: "fedora", previousSessionId: "lobby-session-old-0001" });
  h.stop.fire();
  await done;
});

test("a lapsed session is claimed back; if another lobby took over, this one stops without a backup", async () => {
  const { h, done, server } = await running();
  server.emit(DONE_LINE);
  h.api.pollErrors.push(new LeaseLostError("lapsed"));
  h.timers.fire(POLL_MS);
  await until(() => h.logs.includes("The lobby's slot had lapsed; it's back."));
  expect(h.api.claims[1]!.previousSessionId).toBe(`${LOBBY_SESSION}-1`);

  const refused = "The lobby is already running on pi (heard from it just now). Stop it there first, or run `mc-host admin lobby release`.";
  h.api.pollErrors.push(new LeaseLostError("lapsed"));
  h.api.claimErrors.push(new UserError(refused));
  h.timers.fire(POLL_MS);
  await expect(done).rejects.toThrow(refused);
  expect(server.written.at(-1)).toBe("stop");
  expect(h.events.some((e) => e.startsWith("api:commitBackup"))).toBe(false);
  expect(h.events.some((e) => e.startsWith("api:release"))).toBe(false);
});

test("an unreachable Worker is logged once, and the lobby keeps running", async () => {
  const { h, done } = await running();
  h.api.pollErrors.push(new OfflineError("no network"), new OfflineError("no network"));
  h.timers.fire(POLL_MS);
  await until(() => polls(h.events) === 2);
  h.timers.fire(POLL_MS);
  await until(() => polls(h.events) === 3);
  expect(h.logs.filter((l) => l.startsWith("Can't reach the Worker"))).toEqual([
    "Can't reach the Worker (no network). The lobby keeps running and tries again.",
  ]);
  h.timers.fire(POLL_MS);
  await until(() => h.logs.includes("Reached the Worker again."));
  h.stop.fire();
  await done;
});

test("a Paper crash releases the slot and says Docker restarts it", async () => {
  const { h, done, server } = await running();
  server.exit(1);
  await expect(done).rejects.toThrow("Paper stopped with exit code 1.");
  expect(h.logs).toContain("Last 30 lines of logs/latest.log:\nboom");
  expect(h.events.at(-1)).toBe(`api:release ${LOBBY_SESSION}-1`);
  expect(h.events.some((e) => e.startsWith("api:commitBackup"))).toBe(false);
});
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/lobby-run.test.ts`
Expected: FAIL, `../src/lobby/bridge` doesn't exist.

- [ ] **Step 4: Write `apps/agent/src/lobby/bridge.ts`**

```ts
import type { LobbyHost } from "@mc/protocol";

export const GAME_PORT = 25565;

/**
 * The console line that tells the lobby-bridge plugin who is hosting. The holder goes last and
 * may contain spaces (the plugin reads the rest of the line); world names are slugs already.
 */
export function bridgeCommand(host: LobbyHost | null): string {
  if (!host) return "lobbybridge none";
  const world = host.world.replace(/\s+/g, "-");
  const name = host.name.replace(/\s+/g, " ").trim() || "Someone";
  return `lobbybridge host ${host.address} ${GAME_PORT} ${world} ${name}`;
}
```

- [ ] **Step 5: Write `apps/agent/src/lobby/run.ts`**

```ts
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import type { SnapshotRef, UploadTarget } from "@mc/protocol";
import { LeaseLostError, OfflineError, StaleRevError, type LobbyApi } from "../host/api";
import { ServerConsole, type ServerProcess } from "../host/console";
import { DOWNLOAD_ATTEMPTS, mb, SAVE_TIMEOUT_MS, UPLOAD_ATTEMPTS, type Timers } from "../host/deps";
import { ChecksumError } from "../host/snapshot";
import { tmpDirFor } from "../host/state";
import { bridgeCommand, GAME_PORT } from "./bridge";
import { lobbyServerDir, moveLobbyAside, readLobbyState, restoreLobby, writeLobbyState, zipLobby } from "./folder";

export const POLL_MS = 5_000;
export const LOBBY_BACKUP_MS = 30 * 60_000;

const DONE = /\]: Done \(\d/;
const SAVED = /Saved the game/;
/** 129/130/143: Java stopped by a closed window, Ctrl+C or SIGTERM, which is a normal stop. */
const NORMAL_EXIT = new Set([0, 129, 130, 143]);

/** Everything the lobby touches outside its own logic. Tests swap in fakes. */
export interface LobbyDeps {
  api: LobbyApi;
  dataDir: string;
  log: (line: string) => void;
  address: () => string;
  /** This machine's name, shown to a second lobby that's refused. */
  machine: string;
  /** --fresh: ignore the backups and start an empty lobby. */
  fresh: boolean;
  /** Paper, the bridge plugin, eula.txt, and server.properties for a new lobby. */
  prepareServer: (dir: string) => Promise<void>;
  ensureJava: () => Promise<string>;
  launch: (dir: string, javaBin: string) => ServerProcess;
  forwardInput: (cb: ((line: string) => void) | null) => void;
  download: (url: string, dest: string) => Promise<void>;
  upload: (target: { url: string; headers: Record<string, string> }, file: string) => Promise<void>;
  onStopSignal: (handler: () => void) => () => void;
  crashSummary: (serverDir: string, sinceMs: number) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timers: Timers;
  exit: (code: number) => void;
}

/** mc-host lobby: claim the slot, restore or create the folder, run Paper until it stops. */
export async function runLobby(deps: LobbyDeps): Promise<void> {
  const dir = lobbyServerDir(deps.dataDir);
  const local = await readLobbyState(deps.dataDir);
  const address = deps.address();
  const claim = await deps.api.claim({
    address,
    machine: deps.machine,
    ...(local.sessionId ? { previousSessionId: local.sessionId } : {}),
  });
  await writeLobbyState(deps.dataDir, { ...local, sessionId: claim.sessionId });

  // A restore and Paper's first start can take minutes, so keep the slot alive from here on.
  const stopEarlyPoll = deps.timers.every(POLL_MS, () => void deps.api.poll(claim.sessionId).catch(() => {}));
  const unhookEarly = deps.onStopSignal(() => {
    stopEarlyPoll();
    deps.log("Cancelled. Releasing the lobby slot…");
    void deps.api
      .release(claim.sessionId)
      .catch(() => {})
      .then(() => deps.exit(130));
  });
  let backupRev: number;
  let javaBin: string;
  try {
    backupRev = await restore(deps, dir, local.backupRev);
    await writeLobbyState(deps.dataDir, { sessionId: claim.sessionId, backupRev });
    await deps.prepareServer(dir);
    javaBin = await deps.ensureJava();
  } catch (err) {
    stopEarlyPoll();
    unhookEarly();
    await deps.api.release(claim.sessionId).catch(() => {});
    throw err;
  }

  const st = {
    sessionId: claim.sessionId,
    backupRev,
    ready: false,
    wanted: bridgeCommand(null),
    sent: null as string | null,
    offline: false,
    polling: false,
    lost: null as string | null,
    stopping: false,
    saving: null as Promise<void> | null,
  };
  const startedAt = deps.now();
  const server = deps.launch(dir, javaBin);
  const con = new ServerConsole(server);
  const stop = (why?: string) => {
    if (st.stopping) {
      deps.log("Still stopping, please wait…");
      return;
    }
    st.stopping = true;
    if (why) deps.log(why);
    con.send("stop");
  };
  const unhookStop = deps.onStopSignal(() => stop("Stopping the lobby and backing it up…"));
  unhookEarly();
  stopEarlyPoll();
  let stopPoll = () => {};
  try {
    deps.forwardInput((line) => con.send(line));
    const save = () => writeLobbyState(deps.dataDir, { sessionId: st.sessionId, backupRev: st.backupRev });
    const lose = (why: string) => {
      if (st.lost) return;
      st.lost = why;
      stop();
    };
    /** Paper reads commands only once it's up; until then the latest wish just waits. */
    const tell = () => {
      if (!st.ready || st.wanted === st.sent) return;
      con.send(st.wanted);
      st.sent = st.wanted;
    };
    con.onLine((line) => {
      if (!DONE.test(line)) return;
      st.ready = true;
      deps.log(`The lobby is up. Players connect to mc-lobby (${address}:${GAME_PORT}).`);
      tell();
    });

    /** The slot lapsed (a long outage) or was taken: take it back, unless another lobby holds it. */
    const reclaim = async () => {
      try {
        const again = await deps.api.claim({ address, machine: deps.machine, previousSessionId: st.sessionId });
        st.sessionId = again.sessionId;
        await save();
        deps.log("The lobby's slot had lapsed; it's back.");
      } catch (err) {
        if (err instanceof OfflineError) return;
        lose(`${(err as Error).message} This lobby is stopping without a backup.`);
      }
    };
    const poll = async () => {
      if (st.polling || st.stopping) return;
      st.polling = true;
      try {
        const r = await deps.api.poll(st.sessionId);
        if (st.offline) deps.log("Reached the Worker again.");
        st.offline = false;
        st.wanted = bridgeCommand(r.host);
        tell();
      } catch (err) {
        if (err instanceof LeaseLostError) {
          await reclaim();
        } else if (!st.offline) {
          st.offline = true;
          deps.log(`Can't reach the Worker (${(err as Error).message}). The lobby keeps running and tries again.`);
        }
      } finally {
        st.polling = false;
      }
    };
    stopPoll = deps.timers.every(POLL_MS, () => void poll());
    void poll();

    const backup = async () => {
      const file = join(tmpDirFor(deps.dataDir), "lobby-backup.zip");
      try {
        const zipped = await (async () => {
          try {
            con.send("save-off");
            con.send("save-all flush");
            await con.waitFor(SAVED, SAVE_TIMEOUT_MS);
            return await zipLobby(dir, file);
          } finally {
            if (!st.stopping) con.send("save-on");
          }
        })();
        // Upload after save-on, so the world isn't frozen while it runs.
        st.backupRev = await pushBackup(deps, st.sessionId, file, zipped);
        await save();
        deps.log(`Backed up the lobby as rev ${st.backupRev}.`);
      } catch (err) {
        // A newer backup exists, so another lobby has been running: this folder is out of date.
        if (err instanceof StaleRevError) return lose(`${err.message} This lobby is stopping without a backup.`);
        deps.log(`Warning: ${(err as Error).message} The lobby keeps running, and the next backup tries again.`);
      } finally {
        await rm(file, { force: true });
      }
    };
    const stopBackups = deps.timers.every(LOBBY_BACKUP_MS, () => {
      if (st.stopping || st.saving) return;
      st.saving = backup().finally(() => {
        st.saving = null;
      });
    });

    const code = await server.exited;
    stopBackups();
    stopPoll();
    deps.forwardInput(null);
    if (st.saving) await st.saving;

    if (st.lost) throw new UserError(`${st.lost} Its folder is still at ${dir}.`);
    if (!NORMAL_EXIT.has(code)) {
      deps.log(await deps.crashSummary(dir, startedAt));
      await deps.api.release(st.sessionId).catch(() => {});
      throw new UserError(`Paper stopped with exit code ${code}. Docker starts the lobby again; if it keeps crashing, check the log above.`);
    }

    deps.log("Backing up the lobby…");
    const file = join(tmpDirFor(deps.dataDir), "lobby-final.zip");
    try {
      st.backupRev = await pushBackup(deps, st.sessionId, file, await zipLobby(dir, file));
      await save();
      deps.log(`Backed up the lobby as rev ${st.backupRev}.`);
    } catch (err) {
      deps.log(`Couldn't back up the lobby (${(err as Error).message}). This machine's copy is kept and is backed up next time.`);
    } finally {
      await rm(file, { force: true });
    }
    await deps.api
      .release(st.sessionId)
      .catch((err) => deps.log(`Couldn't release the lobby slot (${(err as Error).message}). It frees itself within 2 minutes.`));
    deps.log("The lobby has stopped.");
  } finally {
    stopPoll();
    unhookStop();
  }
}

/** Decide what the lobby folder starts from. Returns the backup rev the folder now matches. */
async function restore(deps: LobbyDeps, dir: string, localRev: number): Promise<number> {
  const latest = await deps.api.latestBackup();
  const latestRev = latest?.rev ?? 0;
  if (deps.fresh) {
    const dest = await moveLobbyAside(deps.dataDir, deps.now());
    deps.log(dest ? `Starting a fresh lobby. The old one was moved to ${dest}.` : "Starting a fresh lobby.");
    return latestRev;
  }
  const hasLocal = existsSync(join(dir, "server.properties"));
  if (hasLocal && latestRev <= localRev) return localRev;
  if (hasLocal) {
    const dest = await moveLobbyAside(deps.dataDir, deps.now());
    deps.log(`The lobby on this machine is older than the backup (rev ${localRev}, the backup is rev ${latestRev}), so it was moved to ${dest}.`);
  }
  if (!latest) {
    deps.log("There's no lobby backup yet, so this is a fresh lobby.");
    return 0;
  }
  deps.log(`Restoring lobby backup rev ${latest.rev} (${mb(latest.size)} MB)…`);
  try {
    await fetchBackup(deps, latest, dir);
  } catch (err) {
    throw new UserError(
      `Couldn't restore lobby backup rev ${latest.rev}: ${(err as Error).message} Run \`mc-host lobby --fresh\` to start an empty lobby instead.`,
    );
  }
  return latest.rev;
}

/** Download a backup and unpack it into dir, retrying a damaged download. */
async function fetchBackup(deps: Pick<LobbyDeps, "download" | "log" | "dataDir">, latest: SnapshotRef, dir: string): Promise<void> {
  const file = join(tmpDirFor(deps.dataDir), `lobby-${latest.rev}.zip`);
  try {
    for (let attempt = 1; ; attempt++) {
      await deps.download(latest.url, file);
      try {
        await restoreLobby(file, dir, latest.sha256);
        return;
      } catch (err) {
        if (!(err instanceof ChecksumError) || attempt >= DOWNLOAD_ATTEMPTS) throw err;
        deps.log("The lobby backup download is damaged. Trying again…");
      }
    }
  } finally {
    await rm(file, { force: true });
  }
}

/** upload-url → PUT → commit, retried with backoff. A lost slot or a newer backup is never retried. */
async function pushBackup(
  deps: Pick<LobbyDeps, "api" | "upload" | "sleep">,
  sessionId: string,
  file: string,
  zipped: { sha256: string; size: number },
): Promise<number> {
  let last: Error | null = null;
  // Once the PUT has succeeded, retries repeat only the commit, whose reply may have been lost.
  let target: UploadTarget | null = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      if (!target) {
        const next = await deps.api.backupUrl({ sessionId, ...zipped });
        await deps.upload(next, file);
        target = next;
      }
      return await deps.api.commitBackup({ sessionId, rev: target.rev, key: target.key, ...zipped });
    } catch (err) {
      if (err instanceof LeaseLostError || err instanceof StaleRevError) throw err;
      last = err as Error;
      if (attempt < UPLOAD_ATTEMPTS) await deps.sleep(5_000 * 4 ** (attempt - 1));
    }
  }
  throw new UserError(`Couldn't upload the lobby backup after ${UPLOAD_ATTEMPTS} tries (${last?.message}).`);
}
```

- [ ] **Step 6: Run the tests**

Run: `bun test apps/agent/test/lobby-run.test.ts && bun run typecheck`
Expected: PASS. If the "lapsed session" test is flaky, check that `running()` waited for the first poll, so that `pollErrors` is consumed by the fired poll and not by the initial one.

- [ ] **Step 7: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): mc-host lobby's runner: restore, poll, tell the plugin, back up"
```

---

### Task 10: Agent, `mc-host lobby` and the hosting changes

**Files:**
- Create: `apps/agent/src/lobby/command.ts`
- Create: `apps/agent/test/lobby-command.test.ts`
- Modify: `apps/agent/src/host/deps.ts`
- Modify: `apps/agent/src/host/commands.ts`
- Modify: `apps/agent/src/cli.ts`
- Modify: `apps/agent/src/commands.ts`
- Modify: `apps/agent/src/host/prepare.ts`
- Modify: `apps/agent/src/host/run.ts`
- Modify: `apps/agent/package.json`
- Modify: `apps/agent/test/cli.test.ts`, `apps/agent/test/prepare.test.ts`, `apps/agent/test/hosted.test.ts`

**Interfaces:**
- Consumes: `runLobby`, `LobbyDeps` (Task 9); `installPaper`, `installBridge`, `writeFreshProperties`, `paperCommand`, `PAPER` (Task 8); `createLobbyApi` (Task 6); `Manifest.lobby` (Task 1).
- Produces:
  - `cmdLobby(cmd: { fresh: boolean }, deps: Deps): Promise<void>`
  - CLI kind `{ kind: "lobby"; fresh: boolean }`
  - `realTimers: Timers`, `SEND_BACK_MS = 2_000`, `LOBBY_LOOKUP_MS = 3_000` in `host/deps.ts`
  - Env vars read by the lobby: `MC_WORKER_URL`, `MC_TOKEN`, `MC_ACCEPT_EULA`, `MC_LOBBY_MACHINE`, `MC_LOBBY_BRIDGE_JAR`

- [ ] **Step 1: Write the failing tests**

Append to `apps/agent/test/cli.test.ts`:

```ts
test("parses the lobby command", () => {
  expect(parseCommand(["lobby"])).toEqual({ kind: "lobby", fresh: false });
  expect(parseCommand(["lobby", "--fresh"])).toEqual({ kind: "lobby", fresh: true });
});
```

`apps/agent/test/lobby-command.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/commands";
import { cmdLobby } from "../src/lobby/command";

const deps = (env: Record<string, string>): Deps => ({
  fetch: async () => new Response("unused", { status: 500 }),
  cacheDir: mkdtempSync(join(tmpdir(), "mc-lobby-cmd-")),
  configDir: mkdtempSync(join(tmpdir(), "mc-lobby-cfg-")),
  log: () => {},
  ask: async () => "",
  env,
});

test("the lobby needs the EULA agreed through MC_ACCEPT_EULA", async () => {
  await expect(cmdLobby({ fresh: false }, deps({ MC_WORKER_URL: "https://w.test", MC_TOKEN: "t" }))).rejects.toThrow(
    "Running the lobby means agreeing to Mojang's EULA (https://aka.ms/MinecraftEULA). Set MC_ACCEPT_EULA=true once you have; scripts/install-lobby.sh asks you.",
  );
});

test("the lobby needs a Worker URL and a token", async () => {
  await expect(cmdLobby({ fresh: false }, deps({ MC_ACCEPT_EULA: "true" }))).rejects.toThrow("isn't set up to host yet");
});
```

In `apps/agent/test/prepare.test.ts`, in `"a fresh world: claim, build without datapacks, no download"`, add after the `datapacks` expectation:

```ts
  expect(h.builds[0]!.profile.properties["accepts-transfers"]).toBe(true);
```

In `apps/agent/test/hosted.test.ts`, give `started()` a `lobby?: string` option. Change its first line to:

```ts
  const h = makeHarness(await manifestFor({ pregenDone: o.pregenDone, lobby: o.lobby ? { address: o.lobby } : null }), { respond: o.respond });
```

and its option type to `{ rev?: number; pregenDone?: boolean; respond?: (line: string, s: FakeServer) => void; lobby?: string }`. Then append:

```ts
test("stopping sends everyone to the lobby first, when one is up", async () => {
  const { h, done, server } = await started({ lobby: "100.64.0.50" });
  h.stop.fire();
  await done;
  expect(server.written.slice(-2)).toEqual(["transfer 100.64.0.50 25565 @a", "stop"]);
  expect(h.logs).toContain("Sending players back to the lobby…");
});

test("with no lobby, stopping goes straight to stop", async () => {
  const { h, done, server } = await started();
  h.stop.fire();
  await done;
  expect(server.written.some((l) => l.startsWith("transfer"))).toBe(false);
  expect(server.written.at(-1)).toBe("stop");
});

test("a Worker that doesn't answer doesn't hold up the stop", async () => {
  const { h, done, server } = await started({ lobby: "100.64.0.50" });
  h.api.manifest = () => new Promise<never>(() => {});
  h.stop.fire();
  await done;
  expect(server.written.some((l) => l.startsWith("transfer"))).toBe(false);
  expect(server.written.at(-1)).toBe("stop");
}, 10_000);
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/cli.test.ts apps/agent/test/lobby-command.test.ts apps/agent/test/prepare.test.ts apps/agent/test/hosted.test.ts`
Expected: FAIL. `lobby` is unknown, `../src/lobby/command` doesn't exist, `accepts-transfers` is undefined, and no `transfer` line is sent.

- [ ] **Step 3: Shared timers and constants**

In `apps/agent/src/host/deps.ts`, add:

```ts
/** How long players get to switch to the lobby before the server stops. */
export const SEND_BACK_MS = 2_000;
/** The lobby lookup on stop gives up after this, so a hung Worker never holds up the stop. */
export const LOBBY_LOOKUP_MS = 3_000;

export const realTimers: Timers = {
  every: (ms, fn) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
};
```

In `apps/agent/src/host/commands.ts`, replace the inline `timers: { every: … }` object with `timers: realTimers,` and import `realTimers` from `./deps`.

- [ ] **Step 4: Hosts accept transfers and send players back**

In `apps/agent/src/host/prepare.ts`, replace the `deps.build(...)` line:

```ts
    // The lobby sends players here with /transfer, which a server refuses unless this is on.
    const properties = { ...profile.properties, "accepts-transfers": true };
    const marker = await deps.build({ profile: { ...profile, datapacks: [], properties }, lock, dir: serverDir });
```

In `apps/agent/src/host/run.ts`, import `LOBBY_LOOKUP_MS` and `SEND_BACK_MS` from `./deps`, add this helper below the constants at the top of the file:

```ts
/** Resolves to null if `p` takes longer than ms. A real timer, so a faked sleep can't cut it short. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
```

and replace the `stop` function inside `runHosted`:

```ts
  /** If a lobby is up, send everyone there first. Any failure just skips this step. */
  const sendBack = async () => {
    const lobby = await withTimeout(deps.api.manifest().then((m) => m.lobby), LOBBY_LOOKUP_MS).catch(() => null);
    if (!lobby) return;
    deps.log("Sending players back to the lobby…");
    con.send(`transfer ${lobby.address} 25565 @a`);
    await deps.sleep(SEND_BACK_MS);
  };
  const stop = (why?: string) => {
    if (st.stopping) {
      deps.log("Still stopping, please wait…");
      return;
    }
    st.stopping = true;
    if (why) deps.log(why);
    void sendBack().finally(() => con.send("stop"));
  };
```

- [ ] **Step 5: Write `apps/agent/src/lobby/command.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { USER_AGENT, UserError } from "@mc/profile";
import type { Deps } from "../commands";
import { tailnetAddress } from "../host/address";
import { createLobbyApi } from "../host/api";
import { loadHostConfig } from "../host/config";
import { spawnProcess } from "../host/console";
import { realTimers } from "../host/deps";
import { onStopSignal } from "../host/signals";
import { TerminalInput } from "../host/terminal";
import { downloadTo, uploadFile } from "../host/transfer";
import { javaFor } from "../java/runtime";
import { dataDir as defaultDataDir } from "../paths";
import { crashSummary } from "../run/crash";
import { EULA_URL } from "../run/eula";
import { installBridge, installPaper, PAPER, paperCommand, writeFreshProperties } from "./paper";
import { runLobby } from "./run";

export async function cmdLobby(cmd: { fresh: boolean }, deps: Deps): Promise<void> {
  const env = deps.env ?? process.env;
  const cfg = await loadHostConfig(env, deps.configDir);
  // The lobby runs unattended in Docker, so the EULA is agreed once by install-lobby.sh.
  if (env.MC_ACCEPT_EULA !== "true") {
    throw new UserError(
      `Running the lobby means agreeing to Mojang's EULA (${EULA_URL}). Set MC_ACCEPT_EULA=true once you have; scripts/install-lobby.sh asks you.`,
    );
  }
  const rl = createInterface({ input: process.stdin, terminal: false });
  const input = new TerminalInput(rl);
  const download = { fetch: deps.fetch, cacheDir: deps.cacheDir, userAgent: USER_AGENT };
  try {
    await runLobby({
      api: createLobbyApi({ ...cfg, fetch: deps.fetch }),
      dataDir: deps.dataDir ?? defaultDataDir(),
      log: deps.log,
      address: () => tailnetAddress(),
      machine: env.MC_LOBBY_MACHINE || hostname(),
      fresh: cmd.fresh,
      prepareServer: async (dir) => {
        await mkdir(dir, { recursive: true });
        await installPaper(dir, download);
        await installBridge(dir, env.MC_LOBBY_BRIDGE_JAR);
        await writeFreshProperties(dir);
        await writeFile(join(dir, "eula.txt"), "eula=true\n");
      },
      ensureJava: () => javaFor(PAPER, { ...download, log: deps.log, override: deps.javaBin }),
      launch: (dir, javaBin) => spawnProcess(paperCommand(javaBin), dir, (text) => process.stdout.write(text)),
      forwardInput: (cb) => input.forwardTo(cb),
      download: (url, dest) => downloadTo(deps.fetch, url, dest),
      upload: (target, file) => uploadFile(deps.fetch, target, file),
      onStopSignal,
      crashSummary,
      now: deps.now ?? Date.now,
      sleep: (ms) => Bun.sleep(ms),
      timers: realTimers,
      exit: (code) => process.exit(code),
    });
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 6: Wire up the CLI**

In `apps/agent/src/cli.ts`:
- Add `| { kind: "lobby"; fresh: boolean }` to `Command`.
- Add `fresh: { type: "boolean", default: false },` to `parseArgs` options.
- In `USAGE`, after the Hosting block:
  ```
  Lobby
    lobby [--fresh]
        Run the lobby server (scripts/install-lobby.sh sets it up in Docker).
        --fresh        ignore the backups and start an empty lobby
  ```
- Add a case: `case "lobby": return { kind: "lobby", fresh: values.fresh ?? false };`

In `apps/agent/src/commands.ts`, import `cmdLobby` from `./lobby/command` and add `case "lobby": return cmdLobby(cmd, deps);`.

In `apps/agent/package.json`, set `"version": "0.4.0"`.

- [ ] **Step 7: Run all agent tests**

Run: `bun test && bun run typecheck`
Expected: PASS. The hung-Worker test takes about 3 seconds.

- [ ] **Step 8: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): mc-host lobby, and hosts send players back to the lobby on stop"
```

---

### Task 11: The `lobby-bridge` Paper plugin

**Files:**
- Create: `scripts/gradle.sh`
- Create: `paper/lobby-bridge/settings.gradle.kts`
- Create: `paper/lobby-bridge/build.gradle.kts`
- Create: `paper/lobby-bridge/src/main/resources/plugin.yml`
- Create: `paper/lobby-bridge/src/main/java/mc/lobbybridge/Host.java`
- Create: `paper/lobby-bridge/src/main/java/mc/lobbybridge/Lobby.java`
- Create: `paper/lobby-bridge/src/main/java/mc/lobbybridge/Bridge.java`
- Create: `paper/lobby-bridge/src/main/java/mc/lobbybridge/PaperLobby.java`
- Create: `paper/lobby-bridge/src/main/java/mc/lobbybridge/LobbyBridgePlugin.java`
- Create: `paper/lobby-bridge/src/test/java/mc/lobbybridge/FakeLobby.java`
- Create: `paper/lobby-bridge/src/test/java/mc/lobbybridge/BridgeTest.java`
- Modify: `.gitignore`, `package.json`

**Interfaces:**
- Consumes: the console line from Task 9: `lobbybridge host <address> <port> <world> <holder…>` or `lobbybridge none`.
- Produces: `paper/lobby-bridge/build/libs/lobby-bridge.jar`; in-game `/stay` and `/play`; root script `bun run test:plugin`.

- [ ] **Step 1: Gradle in Docker**

`scripts/gradle.sh`:

```bash
#!/usr/bin/env bash
# Run Gradle for paper/lobby-bridge in the official image, so nobody needs Gradle or a JDK installed.
# :z relabels the folder for SELinux (Fedora). Gradle's cache stays inside the project (git-ignored).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec docker run --rm -u "$(id -u):$(id -g)" \
  -v "$REPO/paper/lobby-bridge:/project:z" -w /project \
  -e GRADLE_USER_HOME=/project/.gradle-home \
  gradle:9.8.0-jdk25 gradle --no-daemon -q "$@"
```

Run `chmod +x scripts/gradle.sh`.

Append to `.gitignore`:

```
# Gradle (paper/lobby-bridge)
paper/lobby-bridge/.gradle/
paper/lobby-bridge/.gradle-home/
paper/lobby-bridge/build/
```

In the root `package.json` scripts, add `"test:plugin": "scripts/gradle.sh test"`.

- [ ] **Step 2: The Gradle project**

`paper/lobby-bridge/settings.gradle.kts`:

```kotlin
rootProject.name = "lobby-bridge"
```

`paper/lobby-bridge/build.gradle.kts`:

```kotlin
plugins {
    java
}

group = "mc.lobbybridge"
version = "1.0.0"

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    // Matches the Paper build mc-host runs (apps/agent/src/lobby/paper.ts).
    compileOnly("io.papermc.paper:paper-api:26.3.build.147-beta")
    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(25))
}

tasks.test {
    useJUnitPlatform()
}

tasks.jar {
    archiveFileName.set("lobby-bridge.jar")
}
```

`paper/lobby-bridge/src/main/resources/plugin.yml`:

```yaml
name: LobbyBridge
version: '1.0.0'
main: mc.lobbybridge.LobbyBridgePlugin
api-version: '26.3'
description: Sends lobby players to whoever is hosting. Driven by mc-host lobby.
```

- [ ] **Step 3: Write the failing tests**

`paper/lobby-bridge/src/test/java/mc/lobbybridge/FakeLobby.java`:

```java
package mc.lobbybridge;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class FakeLobby implements Lobby {
    final List<String> players = new ArrayList<>();
    final List<String> events = new ArrayList<>();
    final Set<String> refuseTransfer = new HashSet<>();

    @Override public List<String> online() { return List.copyOf(players); }
    @Override public void broadcast(String message) { events.add("broadcast: " + message); }
    @Override public void message(String player, String message) { events.add(player + " message: " + message); }
    @Override public void actionBar(String player, String message) { events.add(player + " actionbar: " + message); }
    @Override public void title(String player, String title) { events.add(player + " title: " + title); }

    @Override
    public void transfer(String player, String host, int port) {
        if (refuseTransfer.contains(player)) throw new IllegalStateException("not now");
        events.add(player + " -> " + host + ":" + port);
    }

    List<String> transfers() {
        return events.stream().filter(e -> e.contains(" -> ")).toList();
    }
}
```

`paper/lobby-bridge/src/test/java/mc/lobbybridge/BridgeTest.java`:

```java
package mc.lobbybridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class BridgeTest {
    static final Host ALEX = new Host("100.64.0.3", 25565, "adventure", "Alex");
    final FakeLobby lobby = new FakeLobby();
    final Bridge bridge = new Bridge(lobby);

    void ticks(int n) {
        for (int i = 0; i < n; i++) bridge.tick();
    }

    @Test
    void countsDownThenSendsEveryone() {
        lobby.players.addAll(List.of("sam", "kim"));
        bridge.setHost(ALEX);
        assertEquals("broadcast: Alex is hosting adventure. Sending you there in 10s. Type /stay to remain here.", lobby.events.get(0));
        ticks(10);
        assertTrue(lobby.events.contains("sam actionbar: Sending you to Alex's server in 1s"));
        assertTrue(lobby.transfers().isEmpty());
        bridge.tick();
        assertEquals(List.of("sam -> 100.64.0.3:25565", "kim -> 100.64.0.3:25565"), lobby.transfers());
    }

    @Test
    void stayKeepsYouUntilPlay() {
        lobby.players.addAll(List.of("sam", "kim"));
        bridge.setHost(ALEX);
        bridge.stay("sam");
        assertTrue(lobby.events.contains("sam message: You'll stay in the lobby. Type /play when you want to go."));
        ticks(11);
        assertEquals(List.of("kim -> 100.64.0.3:25565"), lobby.transfers());
        bridge.play("sam");
        assertEquals(List.of("kim -> 100.64.0.3:25565", "sam -> 100.64.0.3:25565"), lobby.transfers());
    }

    @Test
    void joiningWhileHostedSendsYouOnTheNextTick() {
        bridge.setHost(ALEX);
        assertTrue(lobby.events.isEmpty());
        lobby.players.add("sam");
        bridge.join("sam");
        assertEquals(List.of("sam title: Sending you to Alex's server…"), lobby.events);
        bridge.tick();
        assertEquals(List.of("sam -> 100.64.0.3:25565"), lobby.transfers());
    }

    @Test
    void hostGoingAwayCancelsTheCountdown() {
        lobby.players.add("sam");
        bridge.setHost(ALEX);
        ticks(3);
        bridge.setHost(null);
        assertTrue(lobby.events.contains("broadcast: Hosting stopped, so nobody is being sent anywhere."));
        ticks(20);
        assertTrue(lobby.transfers().isEmpty());
    }

    @Test
    void theSameHostTwiceIsOneAnnouncement() {
        lobby.players.add("sam");
        bridge.setHost(ALEX);
        bridge.setHost(new Host("100.64.0.3", 25565, "adventure", "Alex"));
        assertEquals(1, lobby.events.stream().filter(e -> e.startsWith("broadcast:")).count());
    }

    @Test
    void nobodyHosting() {
        bridge.join("sam");
        bridge.play("sam");
        bridge.stay("sam");
        assertEquals(List.of(
                "sam message: Nobody's hosting right now. /status in Discord shows who hosted last.",
                "sam message: Nobody's hosting right now. Anyone with mc-host can start with mc-host start.",
                "sam message: Nobody's hosting right now, so you're staying anyway."), lobby.events);
    }

    @Test
    void aRefusedTransferSaysHowToRetry() {
        lobby.players.add("sam");
        lobby.refuseTransfer.add("sam");
        bridge.setHost(ALEX);
        bridge.play("sam");
        assertTrue(lobby.events.contains("sam message: Couldn't send you over. Type /play to try again."));
    }

    @Test
    void consoleCommand() {
        assertEquals("lobbybridge: Sam the Builder is hosting adventure at 100.64.0.9:25565",
                bridge.command("host 100.64.0.9 25565 adventure Sam the Builder"));
        assertEquals(new Host("100.64.0.9", 25565, "adventure", "Sam the Builder"), bridge.host());
        assertEquals("lobbybridge: nobody is hosting", bridge.command("none"));
        assertNull(bridge.host());
        assertTrue(bridge.command("host x notaport w h").startsWith("Usage:"));
        assertTrue(bridge.command("").startsWith("Usage:"));
    }
}
```

- [ ] **Step 4: Run the tests to make sure they fail**

Run: `scripts/gradle.sh test`
Expected: FAIL, compilation errors because `Bridge`, `Host` and `Lobby` don't exist. The first run downloads Gradle's dependencies into `.gradle-home`.

- [ ] **Step 5: Write the rules**

`paper/lobby-bridge/src/main/java/mc/lobbybridge/Host.java`:

```java
package mc.lobbybridge;

/** Who the lobby sends players to, as told by mc-host lobby. */
public record Host(String address, int port, String world, String holder) {}
```

`paper/lobby-bridge/src/main/java/mc/lobbybridge/Lobby.java`:

```java
package mc.lobbybridge;

import java.util.List;

/** The bits of the server Bridge needs, so its rules can be tested without one. Players are named. */
public interface Lobby {
    List<String> online();
    void broadcast(String message);
    void message(String player, String message);
    void actionBar(String player, String message);
    void title(String player, String title);
    /** Throws IllegalStateException when the client can't be transferred right now. */
    void transfer(String player, String host, int port);
}
```

`paper/lobby-bridge/src/main/java/mc/lobbybridge/Bridge.java`:

```java
package mc.lobbybridge;

import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * The lobby's rules. When a host comes up, everyone online gets a countdown and is then sent
 * over, unless they typed /stay. Anyone joining while a host is up is sent on the next tick.
 * tick() is called once a second.
 */
public final class Bridge {
    public static final int COUNTDOWN_SECONDS = 10;
    static final String USAGE = "Usage: lobbybridge none | lobbybridge host <address> <port> <world> <holder>";

    private final Lobby lobby;
    private Host host;
    /** Seconds left, or -1 when no countdown is running. */
    private int countdown = -1;
    private final Set<String> staying = new HashSet<>();
    private final Set<String> arriving = new HashSet<>();

    public Bridge(Lobby lobby) {
        this.lobby = lobby;
    }

    public Host host() {
        return host;
    }

    public void setHost(Host next) {
        if (Objects.equals(host, next)) return;
        boolean counting = countdown >= 0;
        host = next;
        countdown = -1;
        staying.clear();
        arriving.clear();
        if (next == null) {
            if (counting) lobby.broadcast("Hosting stopped, so nobody is being sent anywhere.");
            return;
        }
        if (lobby.online().isEmpty()) return;
        lobby.broadcast(next.holder() + " is hosting " + next.world() + ". Sending you there in " + COUNTDOWN_SECONDS + "s. Type /stay to remain here.");
        countdown = COUNTDOWN_SECONDS;
    }

    public void tick() {
        for (String player : List.copyOf(arriving)) {
            arriving.remove(player);
            send(player);
        }
        if (countdown < 0) return;
        if (countdown == 0) {
            countdown = -1;
            for (String player : lobby.online()) if (!staying.contains(player)) send(player);
            return;
        }
        for (String player : lobby.online()) {
            if (!staying.contains(player)) lobby.actionBar(player, "Sending you to " + host.holder() + "'s server in " + countdown + "s");
        }
        countdown--;
    }

    public void join(String player) {
        if (host == null) {
            lobby.message(player, "Nobody's hosting right now. /status in Discord shows who hosted last.");
            return;
        }
        lobby.title(player, "Sending you to " + host.holder() + "'s server…");
        arriving.add(player);
    }

    public void quit(String player) {
        staying.remove(player);
        arriving.remove(player);
    }

    public void stay(String player) {
        if (host == null) {
            lobby.message(player, "Nobody's hosting right now, so you're staying anyway.");
            return;
        }
        staying.add(player);
        arriving.remove(player);
        lobby.message(player, "You'll stay in the lobby. Type /play when you want to go.");
    }

    public void play(String player) {
        if (host == null) {
            lobby.message(player, "Nobody's hosting right now. Anyone with mc-host can start with mc-host start.");
            return;
        }
        staying.remove(player);
        send(player);
    }

    /** The console command from mc-host lobby: "none", or "host <address> <port> <world> <holder…>". Returns the reply. */
    public String command(String args) {
        String[] parts = args.trim().split("\\s+", 5);
        if (parts.length == 1 && parts[0].equals("none")) {
            setHost(null);
            return "lobbybridge: nobody is hosting";
        }
        if (parts.length == 5 && parts[0].equals("host")) {
            int port;
            try {
                port = Integer.parseInt(parts[2]);
            } catch (NumberFormatException e) {
                return USAGE;
            }
            setHost(new Host(parts[1], port, parts[3], parts[4]));
            return "lobbybridge: " + parts[4] + " is hosting " + parts[3] + " at " + parts[1] + ":" + port;
        }
        return USAGE;
    }

    private void send(String player) {
        try {
            lobby.transfer(player, host.address(), host.port());
        } catch (IllegalStateException e) {
            lobby.message(player, "Couldn't send you over. Type /play to try again.");
        }
    }
}
```

- [ ] **Step 6: Run the tests**

Run: `scripts/gradle.sh test`
Expected: PASS (no output with `-q`, exit code 0).

- [ ] **Step 7: Write the Paper side**

`paper/lobby-bridge/src/main/java/mc/lobbybridge/PaperLobby.java`:

```java
package mc.lobbybridge;

import java.util.List;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.title.Title;
import org.bukkit.Server;
import org.bukkit.entity.Player;

/** Lobby on a real Paper server. Players who left in the meantime are skipped. */
final class PaperLobby implements Lobby {
    private final Server server;

    PaperLobby(Server server) {
        this.server = server;
    }

    @Override
    public List<String> online() {
        return server.getOnlinePlayers().stream().map(Player::getName).toList();
    }

    @Override
    public void broadcast(String message) {
        server.broadcast(Component.text(message, NamedTextColor.GREEN));
    }

    @Override
    public void message(String player, String message) {
        Player p = server.getPlayerExact(player);
        if (p != null) p.sendMessage(Component.text(message, NamedTextColor.YELLOW));
    }

    @Override
    public void actionBar(String player, String message) {
        Player p = server.getPlayerExact(player);
        if (p != null) p.sendActionBar(Component.text(message));
    }

    @Override
    public void title(String player, String title) {
        Player p = server.getPlayerExact(player);
        if (p != null) p.showTitle(Title.title(Component.text(title), Component.empty()));
    }

    @Override
    public void transfer(String player, String host, int port) {
        Player p = server.getPlayerExact(player);
        if (p != null) p.transfer(host, port);
    }
}
```

`paper/lobby-bridge/src/main/java/mc/lobbybridge/LobbyBridgePlugin.java`:

```java
package mc.lobbybridge;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.StringArgumentType;
import io.papermc.paper.command.brigadier.Commands;
import io.papermc.paper.plugin.lifecycle.event.types.LifecycleEvents;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

public final class LobbyBridgePlugin extends JavaPlugin implements Listener {
    private Bridge bridge;

    @Override
    public void onEnable() {
        bridge = new Bridge(new PaperLobby(getServer()));
        getServer().getPluginManager().registerEvents(this, this);
        getServer().getScheduler().runTaskTimer(this, () -> bridge.tick(), 20L, 20L);
        getLifecycleManager().registerEventHandler(LifecycleEvents.COMMANDS, event -> {
            var commands = event.registrar();
            commands.register(Commands.literal("stay")
                    .requires(source -> source.getSender() instanceof Player)
                    .executes(ctx -> {
                        bridge.stay(ctx.getSource().getSender().getName());
                        return Command.SINGLE_SUCCESS;
                    })
                    .build(), "Stay in the lobby when someone starts hosting");
            commands.register(Commands.literal("play")
                    .requires(source -> source.getSender() instanceof Player)
                    .executes(ctx -> {
                        bridge.play(ctx.getSource().getSender().getName());
                        return Command.SINGLE_SUCCESS;
                    })
                    .build(), "Go to whoever is hosting");
            // Typed by mc-host lobby into the console; players can't use it.
            commands.register(Commands.literal("lobbybridge")
                    .requires(source -> source.getSender() instanceof ConsoleCommandSender)
                    .then(Commands.argument("args", StringArgumentType.greedyString())
                            .executes(ctx -> {
                                String reply = bridge.command(StringArgumentType.getString(ctx, "args"));
                                ctx.getSource().getSender().sendPlainMessage(reply);
                                return Command.SINGLE_SUCCESS;
                            }))
                    .build(), "Set by mc-host lobby: who is hosting");
        });
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        bridge.join(event.getPlayer().getName());
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        bridge.quit(event.getPlayer().getName());
    }
}
```

- [ ] **Step 8: Build the jar**

Run: `scripts/gradle.sh build && ls -l paper/lobby-bridge/build/libs/lobby-bridge.jar`
Expected: the tests pass and the jar exists. If compilation fails on a Paper API name, check it against https://jd.papermc.io/paper/26.3/ (the API is pinned to `26.3.build.147-beta`) and fix the import. The rules in `Bridge` don't change.

- [ ] **Step 9: Commit**

```bash
git add scripts/gradle.sh paper/lobby-bridge .gitignore package.json
git commit -m "feat(plugin): lobby-bridge: countdown, /stay, /play, transfer on join"
```

---

### Task 12: Install script, Docker, setup guide

**Files:**
- Create: `infra/docker/lobby.Dockerfile`
- Create: `infra/docker/lobby-compose.yml`
- Create: `scripts/install-lobby.sh`
- Create: `docs/setup/phase-5.md`
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: `mc-host lobby` and its env vars (Task 10); `scripts/gradle.sh` and the plugin jar (Task 11); `mc-host admin lobby token|release` (Task 6).
- Produces: the `mc-lobby` command (`start|stop|console|logs|status|fresh`); the `mc-lobby` compose project; the tailnet device `mc-lobby`.

- [ ] **Step 1: The image**

`infra/docker/lobby.Dockerfile`:

```dockerfile
# Built by scripts/install-lobby.sh around a freshly compiled mc-host and lobby-bridge.jar.
# No Java in the image: mc-host downloads Java 25 into /data/cache/mc-host/java on first start.
FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY mc-host /usr/local/bin/mc-host
COPY lobby-bridge.jar /opt/mc-host/lobby-bridge.jar
ENV MC_DATA_DIR=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache \
    MC_LOBBY_BRIDGE_JAR=/opt/mc-host/lobby-bridge.jar
WORKDIR /data
ENTRYPOINT ["mc-host"]
CMD ["lobby"]
```

- [ ] **Step 2: The compose file**

`infra/docker/lobby-compose.yml`:

```yaml
# Installed to ~/.local/share/mc-lobby/compose.yml by scripts/install-lobby.sh.
# Like the hosting setup, the lobby shares its Tailscale sidecar's network namespace, so port
# 25565 is reachable only on the Minecraft tailnet, as "mc-lobby". Both restart on their own.
name: mc-lobby
services:
  tailscale:
    image: tailscale/tailscale:stable
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY}
      TS_HOSTNAME: mc-lobby
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
      TS_EXTRA_ARGS: --accept-dns=false
    volumes:
      - tailscale-state:/var/lib/tailscale
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add: [NET_ADMIN, NET_RAW]
    restart: unless-stopped
  agent:
    image: mc-lobby:local
    container_name: mc-lobby-agent
    network_mode: service:tailscale
    depends_on: [tailscale]
    init: true
    stdin_open: true
    tty: true
    environment:
      MC_WORKER_URL: ${MC_WORKER_URL}
      MC_TOKEN: ${MC_TOKEN}
      MC_ACCEPT_EULA: ${MC_ACCEPT_EULA}
      MC_LOBBY_MACHINE: ${MC_LOBBY_MACHINE}
    volumes:
      - data:/data
    stop_grace_period: 5m
    restart: unless-stopped
volumes:
  tailscale-state: {}
  data: {}
```

- [ ] **Step 3: The install script**

`scripts/install-lobby.sh`:

```bash
#!/usr/bin/env bash
# Install the lobby (Phase 5) on Linux: Paper in Docker behind its own Tailscale sidecar, named
# mc-lobby on the Minecraft tailnet. Run it from the repo checkout. Running it again rebuilds
# mc-host and the plugin and keeps the lobby's data.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-lobby.sh --worker-url <url> --token <lobby token> --authkey <tskey-...>

  --worker-url   the Worker's URL, e.g. https://mc-bot.<you>.workers.dev
  --token        a lobby token (mc-host admin lobby token <this machine's name>)
  --authkey      a tagged (tag:mc-player), pre-approved Tailscale auth key for the Minecraft tailnet

After the first install, every flag is optional; missing ones keep their current values.
EOF
}

WORKER_URL="" TOKEN="" AUTHKEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker-url) WORKER_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --authkey) AUTHKEY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${XDG_DATA_HOME:-$HOME/.local/share}/mc-lobby"
BIN="$HOME/.local/bin"
ENV_FILE="$APP/.env"

command -v docker >/dev/null || { echo "Docker isn't installed. See https://docs.docker.com/engine/install/, then run this again." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose isn't installed. Install the docker-compose-plugin package, then run this again." >&2; exit 1; }
command -v bun >/dev/null || { echo "Bun is needed to build mc-host. Install it from https://bun.sh, then run this again." >&2; exit 1; }

current() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
OLD_AUTHKEY="$(current TS_AUTHKEY)"
WORKER_URL="${WORKER_URL:-$(current MC_WORKER_URL)}"
TOKEN="${TOKEN:-$(current MC_TOKEN)}"
AUTHKEY="${AUTHKEY:-$OLD_AUTHKEY}"
if [[ -z "$WORKER_URL" || -z "$TOKEN" || -z "$AUTHKEY" ]]; then
  echo "The first install needs --worker-url, --token and --authkey." >&2
  usage >&2
  exit 1
fi

if [[ "$(current MC_ACCEPT_EULA)" != "true" ]]; then
  echo "The lobby runs a Minecraft server, which means agreeing to Mojang's EULA: https://aka.ms/MinecraftEULA"
  read -r -p 'Type "yes" to agree: ' answer
  if [[ "${answer,,}" != "yes" ]]; then echo "You need to agree to the EULA to run the lobby." >&2; exit 1; fi
fi

mkdir -p "$APP/build" "$BIN"
compose() { docker compose --project-directory "$APP" -f "$APP/compose.yml" --env-file "$ENV_FILE" "$@"; }

# A new auth key only takes effect on a fresh Tailscale state.
if [[ -n "$OLD_AUTHKEY" && "$AUTHKEY" != "$OLD_AUTHKEY" ]]; then
  echo "New auth key: resetting the Tailscale sidecar's state."
  compose down >/dev/null 2>&1 || true
  docker volume rm mc-lobby_tailscale-state >/dev/null 2>&1 || true
fi

(umask 077 && printf 'MC_WORKER_URL=%s\nMC_TOKEN=%s\nTS_AUTHKEY=%s\nMC_ACCEPT_EULA=true\nMC_LOBBY_MACHINE=%s\n' \
  "$WORKER_URL" "$TOKEN" "$AUTHKEY" "$(hostname -s)" > "$ENV_FILE")
chmod 600 "$ENV_FILE"

echo "Building mc-host…"
(cd "$REPO" && bun install --frozen-lockfile >/dev/null && bun build apps/agent/src/cli.ts --compile --outfile "$APP/build/mc-host" >/dev/null)
echo "Building the lobby-bridge plugin (the first time downloads Gradle's dependencies)…"
"$REPO/scripts/gradle.sh" build
cp "$REPO/paper/lobby-bridge/build/libs/lobby-bridge.jar" "$APP/build/lobby-bridge.jar"
cp "$REPO/infra/docker/lobby.Dockerfile" "$APP/build/Dockerfile"
echo "Building the mc-lobby:local image…"
docker build -q -t mc-lobby:local "$APP/build" >/dev/null
cp "$REPO/infra/docker/lobby-compose.yml" "$APP/compose.yml"

cat > "$BIN/mc-lobby" <<'SHIM'
#!/usr/bin/env bash
# Installed by minecraft-discord-bot/scripts/install-lobby.sh
set -euo pipefail
APP="${XDG_DATA_HOME:-$HOME/.local/share}/mc-lobby"
compose() { docker compose --project-directory "$APP" -f "$APP/compose.yml" --env-file "$APP/.env" "$@"; }
case "${1:-}" in
  start) compose up -d ;;
  stop) compose stop agent ;;
  console)
    echo "Server console. Detach with Ctrl+P then Ctrl+Q. (Ctrl+C restarts the lobby; use 'mc-lobby stop' to stop it.)"
    exec docker attach mc-lobby-agent ;;
  logs) exec docker logs -f --tail 100 mc-lobby-agent ;;
  status) compose ps ;;
  fresh)
    compose stop agent
    echo "Starting an empty lobby (the backups stay in R2). Ctrl+C backs it up and stops it; then run 'mc-lobby start'."
    compose run --rm -it agent lobby --fresh ;;
  *) echo "Usage: mc-lobby start|stop|console|logs|status|fresh" >&2; exit 1 ;;
esac
SHIM
chmod +x "$BIN/mc-lobby"

compose up -d
echo
echo "The lobby is starting. Watch it with: mc-lobby logs   (the first start downloads Java and Paper)"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH to use the mc-lobby command." ;; esac
```

Run `chmod +x scripts/install-lobby.sh` and `bash -n scripts/install-lobby.sh scripts/gradle.sh`.
Expected: no output (syntax OK).

- [ ] **Step 4: The setup guide**

`docs/setup/phase-5.md`:

````markdown
# Phase 5: Lobby

Design: [../superpowers/specs/2026-10-03-phase-5-lobby-design.md](../superpowers/specs/2026-10-03-phase-5-lobby-design.md)

The lobby is a Paper server at `mc-lobby` on the tailnet. While someone hosts, it sends
players there; otherwise it's a hangout. It runs on one machine at a time (Fedora now, a
Pi later) and backs itself up to R2.

## 1. Deploy the Worker

```bash
cd apps/worker
bunx wrangler d1 migrations apply mc-bot --remote   # adds users.scope, lobby_slot, lobby_backups
bun run deploy
```

## 2. A lobby token and a Tailscale key

```bash
mc-host admin lobby token fedora     # prints the token once
```

In the Minecraft tailnet's admin console → Settings → Keys → Generate auth key: tag
`tag:mc-player`, pre-approved, not reusable. No policy change is needed: the lobby is a
`tag:mc-player` device on port 25565, which every player can already reach.

## 3. Install on Fedora

Docker, Docker Compose and Bun must be installed (they already are for hosting).

```bash
scripts/install-lobby.sh --worker-url https://mc-bot.<you>.workers.dev --token <lobby token> --authkey tskey-…
mc-lobby logs      # wait for "The lobby is up"
```

`/status` in Discord should now say "Lobby: 🟢 up".

## 4. Day to day

| Command | What it does |
|---|---|
| `mc-lobby console` | The server console. `op <your name>` once, then build in creative. Detach with Ctrl+P, Ctrl+Q. |
| `mc-lobby stop` / `start` | Stop (backs up first) and start again. |
| `mc-lobby logs` | Follow the log. |
| `mc-lobby fresh` | Start an empty lobby, ignoring the backups (only if a backup is broken). |

**Plugins** (WorldEdit, holograms, …): stop the lobby, copy the jar in, start it again.

```bash
mc-lobby stop
docker cp WorldEdit.jar mc-lobby-agent:/data/lobby/server/plugins/
mc-lobby start
```

**A downloaded hub map**: the folder you copy in must contain `level.dat`.

```bash
mc-lobby stop
docker run --rm -v mc-lobby_data:/data -v "$PWD/my-hub-map:/map:ro,z" debian:stable-slim \
  sh -c 'rm -rf /data/lobby/server/world && cp -r /map /data/lobby/server/world'
mc-lobby start
```

Maps and plugins live only in the Docker volume and the R2 backups, never in git.

## 5. Moving to the Pi

1. On Fedora: `mc-lobby stop`. It backs up and frees the slot.
2. In the Tailscale admin console, remove the `mc-lobby` machine, so the Pi gets the name.
3. On the Pi: install Docker and Bun, clone the repo, then run `scripts/install-lobby.sh`
   with a token from `mc-host admin lobby token pi` and a new auth key. It restores the
   latest backup.

If Fedora's lobby is started again by mistake while the Pi runs, it's refused ("The lobby
is already running on pi"). If the Pi is off and Fedora starts, Fedora notices its copy is
older than the Pi's last backup, moves it to `lobby/old-…`, and restores the backup.

## 6. If a lobby machine died

The slot frees itself 2 minutes after the last poll. To free it at once:
`mc-host admin lobby release`.

## Checklist

- [ ] Fedora lobby up; join `mc-lobby` from Prism: superflat, adventure mode, "Nobody's hosting" message
- [ ] Host from the Windows VM: lobby players get the countdown and land on the host
- [ ] `/stay` keeps you in the lobby; `/play` sends you
- [ ] Join `mc-lobby` while the host is up: sent within a second
- [ ] Ctrl+C on the host: everyone is sent back to the lobby, then the world saves
- [ ] `mc-lobby stop`: hosting still works; `/status` shows "Lobby: ⚫ down, so connect straight to …"
- [ ] `mc-lobby start` after 30+ minutes up: `mc-lobby logs` shows "Backed up the lobby as rev N"
- [ ] Delete only the lobby's data (`mc-lobby stop`, then `docker rm mc-lobby-agent` and `docker volume rm mc-lobby_data`; the Tailscale state stays), reinstall: the lobby restores from R2
- [ ] Drop in a downloaded hub map; it survives a stop, a backup and a restore
````

- [ ] **Step 5: Roadmap**

In `ROADMAP.md`, under `## Phase 5: Lobby`, add a line after the design link:

```
Setup guide: [docs/setup/phase-5.md](docs/setup/phase-5.md)
```

- [ ] **Step 6: Commit**

```bash
git add infra/docker scripts/install-lobby.sh docs/setup/phase-5.md ROADMAP.md
git commit -m "feat(infra): install-lobby.sh, the mc-lobby image and compose project, setup guide"
```

---

### Task 13: Integration test against the real Worker

**Files:**
- Modify: `apps/agent/test/integration.test.ts`

**Interfaces:**
- Consumes: `createLobbyApi`, `createAdminApi().mintLobbyToken / releaseLobby` (Task 6); `zipLobby`, `restoreLobby` (Task 7); the Worker routes (Tasks 2–5).

- [ ] **Step 1: Write the test**

Add imports to `apps/agent/test/integration.test.ts`: `createLobbyApi` from `../src/host/api`, and `restoreLobby`, `zipLobby` from `../src/lobby/folder`. Then append:

```ts
test.skipIf(!RUN)("a lobby claims its slot, sees the host, and backs up through the real Worker", async () => {
  const admin = createAdminApi({ workerUrl: BASE, secret: "itest", fetch });
  const lobbyToken = await admin.mintLobbyToken("itest");
  const alex = await admin.mintToken({ discordId: "100000000000000003", name: "Alex" });
  const { profile, lockfile } = await worldFiles();
  const world = await admin.createWorld({ name: `itest-lobby-${Date.now()}`, profile, lockfile, replace: true });

  const lobby = createLobbyApi({ workerUrl: BASE, token: lobbyToken, fetch });
  const { sessionId } = await lobby.claim({ address: "100.64.0.50", machine: "itest" });
  expect((await lobby.poll(sessionId)).host).toBeNull();
  await expect(lobby.claim({ address: "100.64.0.51", machine: "other" })).rejects.toThrow("The lobby is already running on itest");

  const host = createAgentApi({ workerUrl: BASE, token: alex, fetch });
  const lease = await host.claim("100.64.0.3");
  expect((await lobby.poll(sessionId)).host).toEqual({ name: "Alex", address: "100.64.0.3", world: world.name, minecraft: "26.3" });
  expect((await host.manifest()).lobby).toEqual({ address: "100.64.0.50" });
  await host.release(lease.sessionId);

  const work = mkdtempSync(join(tmpdir(), "mc-itest-lobby-"));
  mkdirSync(join(work, "src", "world"), { recursive: true });
  writeFileSync(join(work, "src", "world", "level.dat"), "lobby build");
  writeFileSync(join(work, "src", "server.properties"), "motd=Lobby\n");
  const zip = join(work, "backup.zip");
  const zipped = await zipLobby(join(work, "src"), zip);
  const target = await lobby.backupUrl({ sessionId, ...zipped });
  await uploadFile(fetch, target, zip);
  const rev = await lobby.commitBackup({ sessionId, rev: target.rev, key: target.key, ...zipped });

  const latest = await lobby.latestBackup();
  expect(latest).toMatchObject({ rev, sha256: zipped.sha256 });
  const back = join(work, "download.zip");
  await downloadTo(fetch, latest!.url, back);
  await restoreLobby(back, join(work, "restored"), latest!.sha256);
  expect(readFileSync(join(work, "restored", "world", "level.dat"), "utf8")).toBe("lobby build");

  await lobby.release(sessionId);
  expect(await admin.releaseLobby()).toBeNull();
}, 60_000);
```

- [ ] **Step 2: Run it**

Run: `bun run test:integration`
Expected: both integration tests PASS. They start `wrangler dev` with fresh local D1 migrations, including 0004.

- [ ] **Step 3: Run everything once more**

Run: `bun run typecheck && bun run test && bun run test:plugin`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/agent/test/integration.test.ts
git commit -m "test: the lobby against a real local Worker"
```

---

## After the plan

The manual checklist in `docs/setup/phase-5.md` (Fedora lobby + Windows VM host) is the
acceptance test. Releasing `v0.4.0` (tag push) is only needed for Windows hosts to pick up
`accepts-transfers=true` and the send-back. Until then, transfers to a Windows host are
refused: players see a connection error and use `/status` to connect directly.
