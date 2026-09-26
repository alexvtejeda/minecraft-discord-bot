# Phase 2a: Hosting Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone with an agent token runs `mc-host start` to host the active world. The world comes down from R2 and goes back up on autosave and on stop, and it never forks. A maintainer runs everything through `mc-host admin`.

**Architecture:**
- **`packages/protocol`:** zod schemas shared by both sides of the API.
- **`apps/worker`:** a Cloudflare Worker (Hono, D1, R2) with three kinds of routes:
  - agent routes: lease, snapshots, manifest
  - admin routes: worlds, tokens, status
  - a local-only R2 proxy, used by tests and `wrangler dev` because Miniflare has no S3 endpoint to presign against
- **`apps/agent`** (the existing `mc-host` CLI) gains:
  - `host/`: the hosting session, split into `prepare` (manifest, recovery check, claim, download, build) and `run` (console, heartbeat, autosave, stop), on top of small units for snapshot zips, transfers, local state and the console
  - `admin.ts`: the maintainer CLI
- **Linux hosting:** `install.sh` plus Docker Compose with a Tailscale sidecar.

**Tech Stack:**
- Bun 1.3 (agent runtime, `bun test`, `--compile`) and TypeScript 5
- zod 4 and fflate 0.8 (both already in use)
- Worker: Hono 4, aws4fetch 1.0, wrangler 4, and Vitest 4 with `@cloudflare/vitest-plugin` 1.2
- Docker Compose v2 and the `tailscale/tailscale` image

**Spec:** `docs/superpowers/specs/2026-09-26-phase-2a-hosting-design.md` (parent: `docs/superpowers/specs/2026-09-25-minecraft-discord-bot-design.md`). Read the spec before starting any task.

## Where this plan deviates from the spec

These changes are deliberate. Task 16 folds them back into the spec.

1. **Tailnet address.** The agent reads it from `os.networkInterfaces()`: the IPv4 in `100.64.0.0/10`, preferring an interface whose name contains "tailscale". It does *not* use the LocalAPI socket. In Docker the agent shares the sidecar's network namespace, so `tailscale0` is visible directly. On Windows the Tailscale adapter shows up the same way. This removes the socket volume and the need for a Tailscale CLI.
2. **Local R2 proxy.** `wrangler dev` and Miniflare can't serve presigned S3 URLs. When `DEV_R2_PROXY=1`, the Worker hands out URLs to its own `/dev/r2/<key>` route, which reads and writes the R2 binding and checks the sha256 the same way R2 does. The route is off in production.
3. **Commit carries `size` and `sha256`.** They're stored in `snapshots` and checked against the uploaded object.
4. **Manifest carries `lease`** (`null`, or the holder plus `you: boolean`). The recovery check and `mc-host status` need it, so no separate status route is needed.
5. **Docker uses named volumes.** They need no `:Z` SELinux relabel, unlike bind mounts.

## Global Constraints

- **Lease timing:**
  - lease: 10 minutes (`LEASE_MS = 600_000`)
  - heartbeat: every 2 minutes (`HEARTBEAT_MS = 120_000`)
  - autosave: every 30 minutes (`AUTOSAVE_MS = 1_800_000`)
- **Retention:** keep the last 5 snapshots per active world (`KEEP_SNAPSHOTS = 5`). An archived world keeps only its latest snapshot.
- **Presigned URLs** expire after 1 hour (`URL_TTL_SECONDS = 3600`).
- **Snapshot contents:** `<level-name>/`, `config/`, `ops.json`, `banned-players.json`, `banned-ips.json`, `usercache.json`.
  - `<level-name>` is `profile.properties["level-name"]`, defaulting to `world`.
  - `session.lock` is never zipped, because Windows keeps it locked while the server runs.
- **Chunky:** `chunky radius 2000` then `chunky start` on a world at rev 0. `chunky continue` at rev 1 or later while `pregen_done` is false.
- **Session rule:** every heartbeat, upload URL, commit and release needs the `session_id` from the latest claim.
- **Errors:**
  - Every user-facing error is a `UserError`: plain English that says what to do next.
  - The Worker answers errors as `{error, message, holder?}` JSON, where `error` is one of `ERROR_CODES` in `@mc/protocol`.
- **Messages the spec fixes exactly** (copy these verbatim):
  - "`<name>` is already hosting at `<address>` (since HH:MM)."
  - "No world is active yet. A maintainer runs `mc-host admin world create <profile>`."
  - "Your token was rejected. Ask a maintainer for a new one."
  - "Can't reach the server list at `<url>`. …"
  - "Couldn't upload the world. Run `mc-host start` again when you're back online. Your progress is saved on this PC."
- **Package boundaries:** `packages/protocol` and `packages/profile` must not import `node:*` or `bun:*` outside their tests, because the Worker imports them.
- **Test runners:**
  - Bun tests are named `*.test.ts`. Worker tests are named `*.vitest.ts` and run in workerd through `@cloudflare/vitest-plugin`. `bun test` never picks up `*.vitest.ts` files.
  - `bun test` makes no network calls. Integration tests run only with `INTEGRATION=1`.
- **Public repo:** never commit jars, zips, worlds, tokens or secrets. `.dev.vars` and `.env` are already ignored. Never read or print `.env` or `.dev.vars`.
- **Commits:** every message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
  ```

## Review Focus

1. **The server crashes while booting, before `Done (`.** Example: a mod fails to load. Expect the crash path: the log tail, an upload prompt defaulting to No, the local copy moved to `recovered/`, and the lease released. Expect no Chunky commands and no autosave. Tested in Task 13.
2. **Ctrl+C lands while an autosave upload is in flight.** The final upload must wait for the autosave and start from the rev it committed. It must not collide on the same rev and turn a good stop into a lost lease. Tested in Task 13.
3. **The same person starts hosting on a second PC.** The re-claim rotates `session_id`. The first PC's next heartbeat gets `lease_lost`, and it stops cleanly without uploading. Tested in Tasks 4 (Worker) and 13 (agent).
4. **`--import` pointed at the world folder instead of the server folder.** Expect a clear error before anything is created on the Worker. Tested in Task 14.
5. **A profile with a custom `level-name`.** Expect zipping, extracting, the recovery "last save" time and Chunky to all use that folder, not `world/`. Tested in Tasks 9 and 12.

---

## File Structure

```
package.json                      MODIFY  test/typecheck scripts cover the worker
tsconfig.json                     MODIFY  exclude apps/worker (own tsconfig, workers types)
packages/protocol/
  package.json                    NEW
  src/index.ts                    NEW     zod schemas + types for every request/response
  test/protocol.test.ts           NEW
apps/worker/
  package.json, tsconfig.json     NEW
  wrangler.jsonc                  NEW     D1 + R2 bindings, vars
  vitest.config.ts                NEW
  migrations/0001_init.sql        NEW     worlds, snapshots, users, lease
  src/env.ts                      NEW     Env, AppEnv
  src/errors.ts                   NEW     ApiError, handleError, readBody
  src/auth.ts                     NEW     hashToken, agentAuth, adminAuth
  src/storage.ts                  NEW     presigned R2 URLs, dev proxy URLs, base64/hex
  src/lease.ts                    NEW     readLease, isHeld, claim/heartbeat/release/force
  src/worlds.ts                   NEW     activeWorld, validateWorldFiles, createWorld, pruneWorld
  src/users.ts                    NEW     mintToken, listUsers
  src/snapshots.ts                NEW     snapshotKey, beginUpload, commitSnapshot
  src/routes/agent.ts             NEW
  src/routes/admin.ts             NEW
  src/routes/dev.ts               NEW     /dev/r2/* (DEV_R2_PROXY=1 only)
  src/index.ts                    NEW     Hono app
  test/env.d.ts, test/apply-migrations.ts, test/helpers.ts   NEW
  test/*.vitest.ts                NEW
apps/agent/
  package.json                    MODIFY  deps @mc/protocol, fflate, zod
  src/paths.ts                    MODIFY  dataDir()
  src/cli.ts                      MODIFY  start/stop/status/admin commands
  src/commands.ts                 MODIFY  dispatch; cmdRun uses requireJava
  src/run/java.ts                 MODIFY  requireJava
  src/admin.ts                    NEW     mc-host admin …
  src/host/config.ts              NEW     loadHostConfig, loadAdminConfig
  src/host/api.ts                 NEW     AgentApi, AdminApi, error classes, hhmm
  src/host/snapshot.ts            NEW     snapshotPaths, zipSnapshot, extractSnapshot, sha256File
  src/host/transfer.ts            NEW     downloadTo, uploadFile
  src/host/state.ts               NEW     LocalState, read/writeState, moveToRecovered, lastSaveTime
  src/host/address.ts             NEW     tailnetAddress
  src/host/console.ts             NEW     ServerProcess, LineSplitter, ServerConsole, spawnProcess, javaCommand
  src/host/terminal.ts            NEW     TerminalInput
  src/host/deps.ts                NEW     SessionDeps, timing constants
  src/host/sync.ts                NEW     pushZip, uploadSnapshot, fetchSnapshot
  src/host/prepare.ts             NEW     prepare(), recovery check
  src/host/run.ts                 NEW     runHosted()
  src/host/session.ts             NEW     hostSession()
  src/host/commands.ts            NEW     cmdStart, cmdStatus, cmdStop
  test/host-fakes.ts              NEW     FakeApi, FakeServer, ManualTimers, makeDeps, fixtures
  test/*.test.ts                  NEW
  test/integration.test.ts        NEW     INTEGRATION=1 only
infra/docker/Dockerfile           NEW
infra/docker/compose.yml          NEW
scripts/install.sh                NEW
docs/setup/phase-2.md             NEW     deployment + manual checklist
ROADMAP.md                        MODIFY
```

---

### Task 1: `@mc/protocol` package

**Files:**
- Create: `packages/protocol/package.json`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/protocol.test.ts`

**Interfaces:**
- Produces (all exported from `@mc/protocol`):
  - `ERROR_CODES` and `type ErrorCode`
  - These schema/type pairs, each exported as `XSchema` + `type X`:
    - `LeaseInfo {name, hostAddress, claimedAt, expiresAt}`
    - `ErrorBody {error, message, holder?}`
    - `SnapshotRef {rev, sha256, size, url}`
    - `Manifest {world{id,name,minecraft}, profile, lockfile, pregenDone, latest, lease}`
    - `ClaimRequest {hostAddress}`
    - `ClaimResponse {sessionId, baseRev, expiresAt}`
    - `SessionRequest {sessionId}`
    - `HeartbeatResponse {expiresAt}`
    - `Ok {ok: true}`
    - `UploadUrlRequest {sessionId, baseRev, size, sha256}`
    - `UploadTarget {rev, key, url, headers}`
    - `CommitRequest {sessionId, rev, key, size, sha256, pregenDone?}`
    - `CommitResponse {rev}`
    - `CreateWorldRequest {name, profile, lockfile, replace?, imported?}` (the type is `z.input`)
    - `CreateWorldResponse {id, name}`
    - `ImportUrlRequest {size, sha256}`
    - `ImportCommitRequest {key, size, sha256}`
    - `MintTokenRequest {discordId, name}`
    - `MintTokenResponse {token}`
    - `ReleaseResponse {released}`
    - `AdminStatus {world, lease, users}`
  - `Sha256Schema` and `WorldNameSchema`

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/protocol.test.ts`:
```ts
import { expect, test } from "bun:test";
import {
  CommitRequestSchema,
  CreateWorldRequestSchema,
  ErrorBodySchema,
  ManifestSchema,
  MintTokenRequestSchema,
  Sha256Schema,
  WorldNameSchema,
} from "../src/index";

const SHA = "a".repeat(64);

test("sha256 must be 64 lowercase hex chars", () => {
  expect(Sha256Schema.safeParse(SHA).success).toBe(true);
  expect(Sha256Schema.safeParse("A".repeat(64)).success).toBe(false);
  expect(Sha256Schema.safeParse("a".repeat(63)).success).toBe(false);
});

test("world names are short lowercase slugs", () => {
  expect(WorldNameSchema.safeParse("adventure-2026-09-26").success).toBe(true);
  expect(WorldNameSchema.safeParse("-bad").success).toBe(false);
  expect(WorldNameSchema.safeParse("Bad").success).toBe(false);
  expect(WorldNameSchema.safeParse("a".repeat(41)).success).toBe(false);
});

test("create-world defaults replace and imported to false", () => {
  const r = CreateWorldRequestSchema.parse({ name: "w", profile: {}, lockfile: {} });
  expect(r.replace).toBe(false);
  expect(r.imported).toBe(false);
});

test("commit needs a session, a positive rev, size and sha256", () => {
  const ok = { sessionId: "s".repeat(16), rev: 1, key: "worlds/w/1-x.zip", size: 10, sha256: SHA };
  expect(CommitRequestSchema.safeParse(ok).success).toBe(true);
  expect(CommitRequestSchema.safeParse({ ...ok, rev: 0 }).success).toBe(false);
  expect(CommitRequestSchema.safeParse({ ...ok, sessionId: "short" }).success).toBe(false);
});

test("manifest accepts a fresh world with no snapshot and no lease", () => {
  const m = ManifestSchema.parse({
    world: { id: "w", name: "w", minecraft: "26.3" },
    profile: {},
    lockfile: {},
    pregenDone: false,
    latest: null,
    lease: null,
  });
  expect(m.latest).toBeNull();
});

test("error bodies carry a known code and an optional holder", () => {
  const holder = { name: "Alex", hostAddress: "100.64.0.3", claimedAt: 1, expiresAt: 2 };
  expect(ErrorBodySchema.safeParse({ error: "lease_held", message: "m", holder }).success).toBe(true);
  expect(ErrorBodySchema.safeParse({ error: "nope", message: "m" }).success).toBe(false);
});

test("discord ids are digits", () => {
  expect(MintTokenRequestSchema.safeParse({ discordId: "123456789012345678", name: "Alex" }).success).toBe(true);
  expect(MintTokenRequestSchema.safeParse({ discordId: "alex", name: "Alex" }).success).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/protocol`
Expected: FAIL. The error is "Cannot find module '../src/index'".

- [ ] **Step 3: Write the package**

`packages/protocol/package.json`:
```json
{
  "name": "@mc/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "zod": "^4.1.0"
  }
}
```

`packages/protocol/src/index.ts`:
```ts
import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256");
const Rev = z.number().int().nonnegative();
const PositiveRev = z.number().int().positive();
const Size = z.number().int().positive();
const SessionId = z.string().min(16).max(64);

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
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const LeaseInfoSchema = z.object({
  name: z.string(),
  hostAddress: z.string(),
  claimedAt: z.number(),
  expiresAt: z.number(),
});
export type LeaseInfo = z.infer<typeof LeaseInfoSchema>;

export const ErrorBodySchema = z.object({
  error: z.enum(ERROR_CODES),
  message: z.string(),
  holder: LeaseInfoSchema.optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const SnapshotRefSchema = z.object({ rev: PositiveRev, sha256: Sha256Schema, size: Size, url: z.url() });
export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;

export const ManifestSchema = z.object({
  world: z.object({ id: z.string(), name: z.string(), minecraft: z.string() }),
  /** The profile as parsed when the world was created (parse again with parseProfile). */
  profile: z.unknown(),
  /** The pinned lockfile (parse again with parseLock). */
  lockfile: z.unknown(),
  pregenDone: z.boolean(),
  latest: SnapshotRefSchema.nullable(),
  /** Null when nobody holds the lease or it has expired. */
  lease: LeaseInfoSchema.extend({ you: z.boolean() }).nullable(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const ClaimRequestSchema = z.object({ hostAddress: z.string().min(1).max(64) });
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;
export const ClaimResponseSchema = z.object({ sessionId: SessionId, baseRev: Rev, expiresAt: z.number() });
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;
export const SessionRequestSchema = z.object({ sessionId: SessionId });
export type SessionRequest = z.infer<typeof SessionRequestSchema>;
export const HeartbeatResponseSchema = z.object({ expiresAt: z.number() });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;
export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;

export const UploadUrlRequestSchema = z.object({ sessionId: SessionId, baseRev: Rev, size: Size, sha256: Sha256Schema });
export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;
export const UploadTargetSchema = z.object({
  rev: PositiveRev,
  key: z.string().min(1),
  url: z.url(),
  /** Headers the PUT must send exactly (the checksum is part of the signature). */
  headers: z.record(z.string(), z.string()),
});
export type UploadTarget = z.infer<typeof UploadTargetSchema>;
export const CommitRequestSchema = z.object({
  sessionId: SessionId,
  rev: PositiveRev,
  key: z.string().min(1),
  size: Size,
  sha256: Sha256Schema,
  pregenDone: z.boolean().optional(),
});
export type CommitRequest = z.infer<typeof CommitRequestSchema>;
export const CommitResponseSchema = z.object({ rev: PositiveRev });
export type CommitResponse = z.infer<typeof CommitResponseSchema>;

export const WorldNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be up to 40 lowercase letters, digits and dashes, starting with a letter or digit");
export const CreateWorldRequestSchema = z.object({
  name: WorldNameSchema,
  profile: z.unknown(),
  lockfile: z.unknown(),
  replace: z.boolean().default(false),
  imported: z.boolean().default(false),
});
export type CreateWorldRequest = z.input<typeof CreateWorldRequestSchema>;
export const CreateWorldResponseSchema = z.object({ id: z.string(), name: z.string() });
export type CreateWorldResponse = z.infer<typeof CreateWorldResponseSchema>;
export const ImportUrlRequestSchema = z.object({ size: Size, sha256: Sha256Schema });
export type ImportUrlRequest = z.infer<typeof ImportUrlRequestSchema>;
export const ImportCommitRequestSchema = z.object({ key: z.string().min(1), size: Size, sha256: Sha256Schema });
export type ImportCommitRequest = z.infer<typeof ImportCommitRequestSchema>;
export const MintTokenRequestSchema = z.object({
  discordId: z.string().regex(/^\d{5,25}$/, "must be a Discord user ID (digits only)"),
  name: z.string().min(1).max(32),
});
export type MintTokenRequest = z.infer<typeof MintTokenRequestSchema>;
export const MintTokenResponseSchema = z.object({ token: z.string().min(32) });
export type MintTokenResponse = z.infer<typeof MintTokenResponseSchema>;
export const ReleaseResponseSchema = z.object({ released: LeaseInfoSchema.nullable() });
export type ReleaseResponse = z.infer<typeof ReleaseResponseSchema>;
export const AdminStatusSchema = z.object({
  world: z
    .object({
      id: z.string(),
      name: z.string(),
      minecraft: z.string(),
      latestRev: Rev,
      latestAt: z.number().nullable(),
      pregenDone: z.boolean(),
    })
    .nullable(),
  lease: LeaseInfoSchema.nullable(),
  users: z.array(z.object({ discordId: z.string(), name: z.string(), revoked: z.boolean() })),
});
export type AdminStatus = z.infer<typeof AdminStatusSchema>;
```

- [ ] **Step 4: Install and run the test to verify it passes**

Run: `bun install && bun test packages/protocol`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add packages/protocol bun.lock
git commit -F - <<'EOF'
feat(protocol): shared zod schemas for the agent and admin API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 2: Worker skeleton, schema and auth

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/wrangler.jsonc`, `apps/worker/vitest.config.ts`, `apps/worker/migrations/0001_init.sql`, `apps/worker/src/env.ts`, `apps/worker/src/errors.ts`, `apps/worker/src/auth.ts`, `apps/worker/src/index.ts`, `apps/worker/test/env.d.ts`, `apps/worker/test/apply-migrations.ts`, `apps/worker/test/helpers.ts`
- Modify: `package.json` (scripts), `tsconfig.json` (exclude)
- Test: `apps/worker/test/auth.vitest.ts`

**Interfaces:**
- Consumes: `ErrorBody`, `ErrorCode` and `LeaseInfo` from `@mc/protocol`; `sha256Hex`, `profileHash` and `Lockfile` from `@mc/profile`.
- Produces:
  - `interface Env { DB; BUCKET; ADMIN_SECRET; R2_ACCESS_KEY_ID; R2_SECRET_ACCESS_KEY; R2_ACCOUNT_ID; R2_BUCKET_NAME; DEV_R2_PROXY? }`
  - `type AppEnv = { Bindings: Env; Variables: { userId: string; userName: string } }`
  - `class ApiError(code, message, holder?)` with `.status` and `.body()`
  - `handleError(err, c): Response`
  - `readBody<T>(c, schema): Promise<T>`
  - `hashToken(token): Promise<string>`
  - `agentAuth` and `adminAuth` (Hono middleware)
  - `app` (the Hono app, also the default export), including `GET /health`
  - test helpers:
    - `ADMIN_SECRET`
    - `addUser(id?, name?): Promise<token>`
    - `addWorld(id?, status?)`
    - `worldFiles(over?)`
    - `call(method, path, {token?, admin?, body?, env?})`
    - `envWith(over)`

- [ ] **Step 1: Create the package files and install**

`apps/worker/package.json`:
```json
{
  "name": "@mc/worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "@mc/profile": "workspace:*",
    "@mc/protocol": "workspace:*",
    "aws4fetch": "^1.0.20",
    "hono": "^4.13.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "^1.2.8",
    "@cloudflare/workers-types": "^5.20260926.1",
    "vitest": "^4.1.0",
    "wrangler": "^4.141.0"
  }
}
```

`apps/worker/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`apps/worker/wrangler.jsonc`. `database_id` and `R2_ACCOUNT_ID` get their real values in Task 16. Neither is a secret, so both are committed.
```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "mc-bot",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "d1_databases": [
    { "binding": "DB", "database_name": "mc-bot", "database_id": "00000000-0000-0000-0000-000000000000", "migrations_dir": "migrations" }
  ],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "mc-bot" }],
  "vars": {
    "R2_ACCOUNT_ID": "set-in-task-16",
    "R2_BUCKET_NAME": "mc-bot"
  }
}
```

Root `package.json`: replace the `scripts` block with:
```json
  "scripts": {
    "test": "bun test && bun run --cwd apps/worker test",
    "typecheck": "tsc -p . && tsc -p apps/worker"
  },
```

Root `tsconfig.json`: add `"exclude": ["apps/worker"]` after `"include"`.

Run: `bun install`
Expected: installs hono, aws4fetch, wrangler, vitest and the Cloudflare packages without peer-dependency errors.

- [ ] **Step 2: Write the migration, env, errors, auth and app**

`apps/worker/migrations/0001_init.sql`:
```sql
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  mc_version TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  lockfile_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  pregen_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- At most one active world.
CREATE UNIQUE INDEX worlds_one_active ON worlds (status) WHERE status = 'active';

CREATE TABLE snapshots (
  world_id TEXT NOT NULL REFERENCES worlds (id),
  rev INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, rev)
);

CREATE TABLE users (
  discord_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- A single row; holder_id IS NULL means nobody is hosting.
CREATE TABLE lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder_id TEXT REFERENCES users (discord_id),
  session_id TEXT,
  world_id TEXT,
  base_rev INTEGER,
  host_address TEXT,
  claimed_at INTEGER,
  expires_at INTEGER
);
INSERT INTO lease (id) VALUES (1);
```

`apps/worker/src/env.ts`:
```ts
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ADMIN_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  /** "1" only in tests and `wrangler dev`: hand out /dev/r2 URLs instead of presigned R2 URLs. */
  DEV_R2_PROXY?: string;
}

export type AppEnv = { Bindings: Env; Variables: { userId: string; userName: string } };
```

`apps/worker/src/errors.ts`:
```ts
import type { ErrorBody, ErrorCode, LeaseInfo } from "@mc/protocol";
import type { Context } from "hono";
import type { z } from "zod";

const STATUS: Record<ErrorCode, 400 | 401 | 404 | 409 | 500> = {
  unauthorized: 401,
  bad_request: 400,
  not_found: 404,
  no_active_world: 404,
  lease_held: 409,
  lease_lost: 409,
  stale_rev: 409,
  conflict: 409,
  upload_missing: 409,
  internal: 500,
};

/** An error whose message is shown to the person running mc-host. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly holder?: LeaseInfo,
  ) {
    super(message);
  }

  get status() {
    return STATUS[this.code];
  }

  body(): ErrorBody {
    return { error: this.code, message: this.message, ...(this.holder ? { holder: this.holder } : {}) };
  }
}

export function handleError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return c.json(err.body(), err.status);
  console.error(err);
  const body: ErrorBody = { error: "internal", message: "Something went wrong on the server. Try again in a minute." };
  return c.json(body, 500);
}

export async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw new ApiError("bad_request", "The request body isn't valid JSON.");
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError("bad_request", r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  }
  return r.data;
}
```

`apps/worker/src/auth.ts`:
```ts
import { sha256Hex } from "@mc/profile";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env";
import { ApiError } from "./errors";

export const hashToken = (token: string): Promise<string> => sha256Hex(token);

function bearer(header: string | undefined): string | null {
  const m = /^Bearer (\S+)$/.exec(header ?? "");
  return m ? m[1]! : null;
}

const rejected = () => new ApiError("unauthorized", "Your token was rejected. Ask a maintainer for a new one.");

export const agentAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (!token) throw rejected();
  const row = await c.env.DB.prepare("SELECT discord_id, name FROM users WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await hashToken(token))
    .first<{ discord_id: string; name: string }>();
  if (!row) throw rejected();
  c.set("userId", row.discord_id);
  c.set("userName", row.name);
  await next();
});

/** Compare hashes so the comparison takes the same time whatever the input. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (!token || !c.env.ADMIN_SECRET || !(await sameSecret(token, c.env.ADMIN_SECRET))) {
    throw new ApiError("unauthorized", "The admin secret was rejected. Check MC_ADMIN_SECRET.");
  }
  await next();
});
```

`apps/worker/src/index.ts`. Later tasks mount the routers where the comment says:
```ts
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { ApiError, handleError } from "./errors";

export const app = new Hono<AppEnv>();
app.onError(handleError);
app.notFound((c) => handleError(new ApiError("not_found", "There's nothing at this address."), c));
app.get("/health", (c) => c.text("ok"));
// routers: mounted by later tasks

export default app;
```

- [ ] **Step 3: Write the test setup and the failing auth test**

`apps/worker/vitest.config.ts`:
```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_SECRET: "test-admin",
            R2_ACCESS_KEY_ID: "AKIDTEST",
            R2_SECRET_ACCESS_KEY: "test-secret",
            R2_ACCOUNT_ID: "acct",
            DEV_R2_PROXY: "1",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.vitest.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
```

`apps/worker/test/env.d.ts`:
```ts
declare namespace Cloudflare {
  interface Env extends import("../src/env").Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
```

`apps/worker/test/apply-migrations.ts`:
```ts
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`apps/worker/test/helpers.ts`:
```ts
import { profileHash, sha256Hex, type Lockfile } from "@mc/profile";
import { env } from "cloudflare:workers";
import { makeProfile } from "../../../packages/profile/test/fakes";
import type { Env } from "../src/env";
import { app } from "../src/index";

export const ADMIN_SECRET = "test-admin";

/** Insert a user directly and return their plaintext token. */
export async function addUser(id = "100000000000000001", name = "Alex"): Promise<string> {
  const token = `token-${id}-0123456789abcdef0123456789`;
  await env.DB.prepare("INSERT INTO users (discord_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, name, await sha256Hex(token), 1)
    .run();
  return token;
}

/** A matching profile + lockfile pair (no mod files) for world creation. */
export async function worldFiles(over: Record<string, unknown> = {}) {
  const profile = makeProfile(over);
  const lockfile: Lockfile = {
    lockfileVersion: 1,
    profile: profile.name,
    profileHash: await profileHash(profile),
    minecraft: profile.minecraft,
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files: [],
  };
  return { profile, lockfile };
}

/** Insert a world row directly (id doubles as its name). */
export async function addWorld(id = "w1", status: "active" | "archived" = "active"): Promise<void> {
  const { profile, lockfile } = await worldFiles();
  await env.DB.prepare(
    "INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at) VALUES (?, ?, '26.3', ?, ?, ?, 0, 1)",
  )
    .bind(id, id, JSON.stringify(profile), JSON.stringify(lockfile), status)
    .run();
}

export function envWith(over: Partial<Env>): Env {
  return {
    DB: env.DB,
    BUCKET: env.BUCKET,
    ADMIN_SECRET: env.ADMIN_SECRET,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_BUCKET_NAME: env.R2_BUCKET_NAME,
    DEV_R2_PROXY: env.DEV_R2_PROXY,
    ...over,
  };
}

export async function call(
  method: string,
  path: string,
  o: { token?: string; admin?: boolean; body?: unknown; env?: Env } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (o.admin) headers.Authorization = `Bearer ${ADMIN_SECRET}`;
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, o.env ?? env);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}
```

`apps/worker/test/auth.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adminAuth, agentAuth } from "../src/auth";
import type { AppEnv } from "../src/env";
import { handleError } from "../src/errors";
import { addUser, ADMIN_SECRET, call } from "./helpers";

function probe() {
  const t = new Hono<AppEnv>();
  t.onError(handleError);
  t.get("/agent", agentAuth, (c) => c.text(c.var.userName));
  t.get("/admin", adminAuth, (c) => c.text("admin ok"));
  return t;
}
const get = (path: string, auth?: string) =>
  probe().request(path, { headers: auth ? { Authorization: auth } : {} }, env);

describe("health and unknown routes", () => {
  it("answers /health", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body).toBe("ok");
  });
  it("answers unknown paths with a JSON not_found", async () => {
    const r = await call("GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
  });
});

describe("agentAuth", () => {
  it("accepts a known token and exposes the user's name", async () => {
    const token = await addUser("100000000000000001", "Alex");
    const res = await get("/agent", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Alex");
  });

  it("rejects a missing, unknown or revoked token with the spec's message", async () => {
    const token = await addUser("100000000000000002", "Sam");
    await env.DB.prepare("UPDATE users SET revoked_at = 5 WHERE discord_id = ?").bind("100000000000000002").run();
    for (const auth of [undefined, "Bearer nope", `Bearer ${token}`, token]) {
      const res = await get("/agent", auth);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "unauthorized",
        message: "Your token was rejected. Ask a maintainer for a new one.",
      });
    }
  });
});

describe("adminAuth", () => {
  it("accepts ADMIN_SECRET and nothing else", async () => {
    expect((await get("/admin", `Bearer ${ADMIN_SECRET}`)).status).toBe(200);
    expect((await get("/admin", "Bearer wrong")).status).toBe(401);
    const token = await addUser("100000000000000003", "Kim");
    expect((await get("/admin", `Bearer ${token}`)).status).toBe(401);
    expect((await get("/admin")).status).toBe(401);
  });
});
```

- [ ] **Step 4: Run the Worker tests**

Run: `cd apps/worker && npx vitest run`
Expected: PASS (5 tests). If `@cloudflare/vitest-plugin` rejects an option name, check its README (`node_modules/@cloudflare/vitest-plugin/README.md`) and the fixtures linked there, and fix only `vitest.config.ts`.

- [ ] **Step 5: Typecheck, check that `bun test` ignores the Worker tests, and commit**

Run: `bun run typecheck && bun test 2>&1 | tail -3`
Expected: no type errors. The `bun test` summary lists only Bun test files, with no `*.vitest.ts` among them.

```bash
git add package.json tsconfig.json bun.lock apps/worker
git commit -F - <<'EOF'
feat(worker): skeleton with D1 schema, error handling and token auth

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 3: Storage URLs and the dev R2 proxy

**Files:**
- Create: `apps/worker/src/storage.ts`, `apps/worker/src/routes/dev.ts`
- Modify: `apps/worker/src/index.ts` (mount `/dev`)
- Test: `apps/worker/test/storage.vitest.ts`

**Interfaces:**
- Consumes: `Env` and `AppEnv`; `ApiError`.
- Produces:
  - `URL_TTL_SECONDS = 3600`
  - `interface PutTarget { url: string; headers: Record<string, string> }`
  - `interface Storage { getUrl(key): Promise<string>; putTarget(key, sha256Hex): Promise<PutTarget> }`
  - `r2Storage(env, now?): Storage`
  - `devStorage(origin): Storage`
  - `storageFor(env, requestUrl): Storage`
  - `hexToBase64(hex)` and `base64ToHex(b64)`
  - `dev`: a Hono router for `GET|PUT /dev/r2/*`

- [ ] **Step 1: Write the failing test**

`apps/worker/test/storage.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { base64ToHex, devStorage, hexToBase64, r2Storage, storageFor } from "../src/storage";
import { envWith } from "./helpers";

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sha = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("hex and base64", () => {
  it("round-trips the sha256 of the empty string", () => {
    expect(hexToBase64(EMPTY_SHA)).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    expect(base64ToHex("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=")).toBe(EMPTY_SHA);
  });
});

describe("r2Storage", () => {
  const fixed = () => new Date("2026-09-26T12:00:00Z");
  const s = r2Storage(envWith({ R2_ACCOUNT_ID: "acct", R2_BUCKET_NAME: "mc-bot" }), fixed);

  it("presigns a GET on the account endpoint that expires in an hour", async () => {
    const url = new URL(await s.getUrl("worlds/w1/1-abc.zip"));
    expect(url.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/mc-bot/worlds/w1/1-abc.zip");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260926T120000Z");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs the checksum header into a PUT and returns it for the uploader", async () => {
    const t = await s.putTarget("worlds/w1/2-abc.zip", EMPTY_SHA);
    expect(t.headers).toEqual({ "x-amz-checksum-sha256": hexToBase64(EMPTY_SHA) });
    expect(new URL(t.url).searchParams.get("X-Amz-SignedHeaders")).toContain("x-amz-checksum-sha256");
  });

  it("is deterministic for a fixed clock", async () => {
    expect(await s.getUrl("k.zip")).toBe(await s.getUrl("k.zip"));
  });
});

describe("dev proxy", () => {
  it("picks dev URLs only when DEV_R2_PROXY is 1", async () => {
    expect(await storageFor(envWith({ DEV_R2_PROXY: "1" }), "http://localhost/agent/x").getUrl("a/b.zip")).toBe(
      "http://localhost/dev/r2/a/b.zip",
    );
    expect(await storageFor(envWith({ DEV_R2_PROXY: undefined }), "http://localhost/x").getUrl("a/b.zip")).toContain(
      "r2.cloudflarestorage.com",
    );
  });

  it("stores a PUT whose checksum matches and serves it back", async () => {
    const body = new TextEncoder().encode("world bytes");
    const t = await devStorage("http://localhost").putTarget("worlds/w1/1-a.zip", await sha(body));
    const put = await app.request(t.url, { method: "PUT", headers: t.headers, body }, env);
    expect(put.status).toBe(200);
    const head = await env.BUCKET.head("worlds/w1/1-a.zip");
    expect(head?.size).toBe(body.length);
    const get = await app.request("http://localhost/dev/r2/worlds/w1/1-a.zip", {}, env);
    expect(await get.text()).toBe("world bytes");
  });

  it("rejects a PUT whose body doesn't match the checksum, like R2 does", async () => {
    const t = await devStorage("http://localhost").putTarget("worlds/w1/1-b.zip", EMPTY_SHA);
    const put = await app.request(t.url, { method: "PUT", headers: t.headers, body: "not empty" }, env);
    expect(put.status).toBe(400);
    expect(await env.BUCKET.head("worlds/w1/1-b.zip")).toBeNull();
  });

  it("is switched off without DEV_R2_PROXY", async () => {
    const res = await app.request("http://localhost/dev/r2/x.zip", {}, envWith({ DEV_R2_PROXY: undefined }));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/storage.vitest.ts`
Expected: FAIL. The error is "Cannot find module '../src/storage'" or similar.

- [ ] **Step 3: Implement storage and the dev router**

`apps/worker/src/storage.ts`:
```ts
import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

export const URL_TTL_SECONDS = 3600;

export interface PutTarget {
  url: string;
  /** Headers the uploader must send exactly; the checksum is part of the signature. */
  headers: Record<string, string>;
}

export interface Storage {
  getUrl(key: string): Promise<string>;
  putTarget(key: string, sha256Hex: string): Promise<PutTarget>;
}

export function hexToBase64(hex: string): string {
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

export function base64ToHex(b64: string): string {
  return [...atob(b64)].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, "");
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

type R2Env = Pick<Env, "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "R2_ACCOUNT_ID" | "R2_BUCKET_NAME">;

/** Presigned URLs against R2's S3 endpoint. Large files never pass through the Worker. */
export function r2Storage(env: R2Env, now: () => Date = () => new Date()): Storage {
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const base = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/`;
  const sign = async (key: string, method: "GET" | "PUT", headers: Record<string, string>) => {
    const url = new URL(base + encodeKey(key));
    url.searchParams.set("X-Amz-Expires", String(URL_TTL_SECONDS));
    const req = await aws.sign(url.toString(), { method, headers, aws: { signQuery: true, datetime: amzDate(now()) } });
    return req.url;
  };
  return {
    getUrl: (key) => sign(key, "GET", {}),
    async putTarget(key, sha256Hex) {
      const headers = { "x-amz-checksum-sha256": hexToBase64(sha256Hex) };
      return { url: await sign(key, "PUT", headers), headers };
    },
  };
}

/** URLs to this Worker's own /dev/r2 route, for wrangler dev and tests (Miniflare has no S3 endpoint). */
export function devStorage(origin: string): Storage {
  const url = (key: string) => `${origin}/dev/r2/${encodeKey(key)}`;
  return {
    getUrl: async (key) => url(key),
    putTarget: async (key, sha256Hex) => ({ url: url(key), headers: { "x-amz-checksum-sha256": hexToBase64(sha256Hex) } }),
  };
}

export function storageFor(env: Env, requestUrl: string): Storage {
  return env.DEV_R2_PROXY === "1" ? devStorage(new URL(requestUrl).origin) : r2Storage(env);
}
```

`apps/worker/src/routes/dev.ts`:
```ts
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { base64ToHex } from "../storage";

export const dev = new Hono<AppEnv>();

dev.use("*", async (c, next) => {
  if (c.env.DEV_R2_PROXY !== "1") throw new ApiError("not_found", "There's nothing at this address.");
  await next();
});

const keyOf = (path: string) => path.slice("/dev/r2/".length).split("/").map(decodeURIComponent).join("/");

dev.get("/r2/*", async (c) => {
  const obj = await c.env.BUCKET.get(keyOf(c.req.path));
  if (!obj) throw new ApiError("not_found", "No such object.");
  return new Response(obj.body, { headers: { "Content-Length": String(obj.size) } });
});

dev.put("/r2/*", async (c) => {
  const b64 = c.req.header("x-amz-checksum-sha256");
  if (!b64) throw new ApiError("bad_request", "Missing x-amz-checksum-sha256.");
  const body = await c.req.arrayBuffer();
  try {
    await c.env.BUCKET.put(keyOf(c.req.path), body, { sha256: base64ToHex(b64) });
  } catch {
    throw new ApiError("bad_request", "BadDigest: the upload didn't match its sha256.");
  }
  return c.body(null, 200);
});
```

In `apps/worker/src/index.ts`, add the import and mount it. Replace the `// routers: mounted by later tasks` line with:
```ts
app.route("/dev", dev);
// routers: mounted by later tasks
```
and add `import { dev } from "./routes/dev";` with the other imports.

- [ ] **Step 4: Run the tests**

Run: `cd apps/worker && npx vitest run`
Expected: PASS (all auth and storage tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -F - <<'EOF'
feat(worker): presigned R2 URLs and a local-only R2 proxy for dev and tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---
### Task 4: Lease logic

**Files:**
- Create: `apps/worker/src/lease.ts`
- Test: `apps/worker/test/lease.vitest.ts`

**Interfaces:**
- Consumes: `ApiError`; `LeaseInfo` from `@mc/protocol`; test helpers `addUser` and `addWorld`.
- Produces:
  - `LEASE_MS = 600_000`
  - `interface LeaseRow { holder_id, holder_name, session_id, world_id, base_rev, host_address, claimed_at, expires_at }` (all nullable)
  - `readLease(db): Promise<LeaseRow>`
  - `isHeld(lease, now): boolean`
  - `leaseInfo(lease): LeaseInfo`
  - `claimLease(db, {userId, hostAddress, worldId, now}): Promise<{sessionId, baseRev, expiresAt}>`, which throws `lease_held`
  - `heartbeatLease(db, sessionId, now): Promise<number>`, which throws `lease_lost`
  - `releaseLease(db, sessionId): Promise<void>`, which throws `lease_lost`
  - `forceRelease(db, now): Promise<LeaseInfo | null>`
  - `requireSession(db, sessionId): Promise<LeaseRow & { world_id: string }>`, which throws `lease_lost`
  - `leaseLostError(): ApiError`

- [ ] **Step 1: Write the failing test**

`apps/worker/test/lease.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimLease,
  forceRelease,
  heartbeatLease,
  isHeld,
  LEASE_MS,
  readLease,
  releaseLease,
  requireSession,
} from "../src/lease";
import { addUser, addWorld } from "./helpers";

const ALEX = "100000000000000001";
const SAM = "100000000000000002";
const claim = (userId: string, now: number, hostAddress = "100.64.0.3") =>
  claimLease(env.DB, { userId, hostAddress, worldId: "w1", now });

beforeEach(async () => {
  await addUser(ALEX, "Alex");
  await addUser(SAM, "Sam");
  await addWorld("w1");
});

describe("claim", () => {
  it("takes a free lease and starts at the latest rev", async () => {
    await env.DB.prepare(
      "INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at) VALUES ('w1', 1, 'k1', 1, 'x', 'a', 1), ('w1', 2, 'k2', 1, 'x', 'a', 2)",
    ).run();
    const c = await claim(ALEX, 1_000);
    expect(c.baseRev).toBe(2);
    expect(c.expiresAt).toBe(1_000 + LEASE_MS);
    expect(c.sessionId.length).toBeGreaterThanOrEqual(16);
    const l = await readLease(env.DB);
    expect(l.holder_name).toBe("Alex");
    expect(isHeld(l, 1_000)).toBe(true);
  });

  it("refuses someone else while held, naming the holder", async () => {
    await claim(ALEX, 1_000);
    await expect(claim(SAM, 2_000, "100.64.0.9")).rejects.toMatchObject({
      code: "lease_held",
      holder: { name: "Alex", hostAddress: "100.64.0.3", claimedAt: 1_000 },
    });
  });

  it("lets someone else take an expired lease, which kills the old session", async () => {
    const old = await claim(ALEX, 1_000);
    const next = await claim(SAM, 1_000 + LEASE_MS + 1);
    expect(next.sessionId).not.toBe(old.sessionId);
    await expect(heartbeatLease(env.DB, old.sessionId, 5_000)).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("lets the holder re-claim, rotating the session (second PC case)", async () => {
    const first = await claim(ALEX, 1_000);
    const second = await claim(ALEX, 2_000, "100.64.0.7");
    expect(second.sessionId).not.toBe(first.sessionId);
    await expect(heartbeatLease(env.DB, first.sessionId, 3_000)).rejects.toMatchObject({ code: "lease_lost" });
    expect((await readLease(env.DB)).host_address).toBe("100.64.0.7");
  });

  it("gives exactly one winner when two people claim at once", async () => {
    const results = await Promise.allSettled([claim(ALEX, 1_000), claim(SAM, 1_000)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("heartbeat, release and force release", () => {
  it("heartbeat pushes the expiry out", async () => {
    const c = await claim(ALEX, 1_000);
    expect(await heartbeatLease(env.DB, c.sessionId, 50_000)).toBe(50_000 + LEASE_MS);
    expect((await readLease(env.DB)).expires_at).toBe(50_000 + LEASE_MS);
  });

  it("release clears the lease; a stale session can't release", async () => {
    const c = await claim(ALEX, 1_000);
    await expect(releaseLease(env.DB, "not-the-session-id")).rejects.toMatchObject({ code: "lease_lost" });
    await releaseLease(env.DB, c.sessionId);
    const l = await readLease(env.DB);
    expect(l.holder_id).toBeNull();
    expect(isHeld(l, 1_000)).toBe(false);
    await expect(requireSession(env.DB, c.sessionId)).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("force release reports who held it, then nothing", async () => {
    await claim(ALEX, 1_000);
    expect(await forceRelease(env.DB, 2_000)).toMatchObject({ name: "Alex" });
    expect(await forceRelease(env.DB, 2_000)).toBeNull();
  });

  it("an expired lease isn't held", async () => {
    await claim(ALEX, 1_000);
    expect(isHeld(await readLease(env.DB), 1_000 + LEASE_MS + 1)).toBe(false);
  });

  it("requireSession returns the lease for the current session", async () => {
    const c = await claim(ALEX, 1_000);
    expect((await requireSession(env.DB, c.sessionId)).world_id).toBe("w1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/lease.vitest.ts`
Expected: FAIL. The error is "Cannot find module '../src/lease'".

- [ ] **Step 3: Implement `lease.ts`**

`apps/worker/src/lease.ts`:
```ts
import type { LeaseInfo } from "@mc/protocol";
import { ApiError } from "./errors";

export const LEASE_MS = 10 * 60_000;

export interface LeaseRow {
  holder_id: string | null;
  holder_name: string | null;
  session_id: string | null;
  world_id: string | null;
  base_rev: number | null;
  host_address: string | null;
  claimed_at: number | null;
  expires_at: number | null;
}

const CLEAR =
  "UPDATE lease SET holder_id = NULL, session_id = NULL, world_id = NULL, base_rev = NULL, host_address = NULL, claimed_at = NULL, expires_at = NULL";

export function leaseLostError(): ApiError {
  return new ApiError(
    "lease_lost",
    "This hosting session is no longer valid: someone else claimed the lease, or a maintainer released it.",
  );
}

export async function readLease(db: D1Database): Promise<LeaseRow> {
  const row = await db
    .prepare(
      `SELECT l.holder_id, u.name AS holder_name, l.session_id, l.world_id, l.base_rev, l.host_address, l.claimed_at, l.expires_at
       FROM lease l LEFT JOIN users u ON u.discord_id = l.holder_id WHERE l.id = 1`,
    )
    .first<LeaseRow>();
  if (!row) throw new Error("The lease row is missing. Apply the D1 migrations.");
  return row;
}

export function isHeld(l: LeaseRow, now: number): boolean {
  return l.holder_id !== null && (l.expires_at ?? 0) >= now;
}

export function leaseInfo(l: LeaseRow): LeaseInfo {
  return {
    name: l.holder_name ?? "Someone",
    hostAddress: l.host_address ?? "an unknown address",
    claimedAt: l.claimed_at ?? 0,
    expiresAt: l.expires_at ?? 0,
  };
}

/** One conditional UPDATE, so two simultaneous claims can't both win. */
export async function claimLease(
  db: D1Database,
  o: { userId: string; hostAddress: string; worldId: string; now: number },
): Promise<{ sessionId: string; baseRev: number; expiresAt: number }> {
  const row = await db
    .prepare(
      `UPDATE lease SET holder_id = ?1, session_id = ?2, world_id = ?3,
         base_rev = (SELECT COALESCE(MAX(rev), 0) FROM snapshots WHERE world_id = ?3),
         host_address = ?4, claimed_at = ?5, expires_at = ?6
       WHERE id = 1 AND (holder_id IS NULL OR expires_at < ?5 OR holder_id = ?1)
       RETURNING session_id, base_rev, expires_at`,
    )
    .bind(o.userId, crypto.randomUUID(), o.worldId, o.hostAddress, o.now, o.now + LEASE_MS)
    .first<{ session_id: string; base_rev: number; expires_at: number }>();
  if (row) return { sessionId: row.session_id, baseRev: row.base_rev, expiresAt: row.expires_at };
  const l = await readLease(db);
  throw new ApiError("lease_held", `${l.holder_name ?? "Someone"} is already hosting at ${l.host_address}.`, leaseInfo(l));
}

export async function heartbeatLease(db: D1Database, sessionId: string, now: number): Promise<number> {
  const r = await db.prepare("UPDATE lease SET expires_at = ?1 WHERE id = 1 AND session_id = ?2").bind(now + LEASE_MS, sessionId).run();
  if (r.meta.changes !== 1) throw leaseLostError();
  return now + LEASE_MS;
}

export async function releaseLease(db: D1Database, sessionId: string): Promise<void> {
  const r = await db.prepare(`${CLEAR} WHERE id = 1 AND session_id = ?`).bind(sessionId).run();
  if (r.meta.changes !== 1) throw leaseLostError();
}

/** Maintainer override for a stuck lease. Returns who held it, or null if nobody did. */
export async function forceRelease(db: D1Database, now: number): Promise<LeaseInfo | null> {
  const l = await readLease(db);
  await db.prepare(`${CLEAR} WHERE id = 1`).run();
  return isHeld(l, now) ? leaseInfo(l) : null;
}

export async function requireSession(db: D1Database, sessionId: string): Promise<LeaseRow & { world_id: string }> {
  const l = await readLease(db);
  if (!l.holder_id || l.session_id !== sessionId || !l.world_id) throw leaseLostError();
  return l as LeaseRow & { world_id: string };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/worker && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -F - <<'EOF'
feat(worker): lease claim, heartbeat and release with rotating sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 5: Worlds, tokens and the admin API

**Files:**
- Create: `apps/worker/src/worlds.ts`, `apps/worker/src/users.ts`, `apps/worker/src/routes/admin.ts`
- Modify: `apps/worker/src/index.ts` (mount `/admin`)
- Test: `apps/worker/test/admin.vitest.ts`

**Interfaces:**
- Consumes:
  - `readLease`, `isHeld`, `leaseInfo` and `forceRelease` from Task 4
  - `hashToken` and `adminAuth` from Task 2
  - `parseProfile`, `parseLock`, `profileHash`, `serializeLock`, `Profile` and `Lockfile` from `@mc/profile`
  - `CreateWorldRequestSchema`, `MintTokenRequestSchema`, `AdminStatus`, `CreateWorldResponse`, `MintTokenResponse` and `ReleaseResponse` from `@mc/protocol`
- Produces:
  - `interface WorldRow { id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at }`
  - `interface SnapshotRow { world_id, rev, r2_key, size, sha256, uploaded_by, created_at }`
  - `activeWorld(db): Promise<WorldRow | null>`
  - `requireActiveWorld(db): Promise<WorldRow>`, which throws `no_active_world`
  - `latestSnapshot(db, worldId): Promise<SnapshotRow | null>`
  - `validateWorldFiles(rawProfile, rawLock): Promise<{profile, lock}>`
  - `createWorld(env, {name, profile, lock, replace, imported, now}): Promise<{id, name}>`
  - `revOfKey(key): number`
  - `pruneWorld(env, worldId, keep): Promise<void>`
  - `mintToken(db, discordId, name, now): Promise<string>`
  - `listUsers(db)`
  - routes `POST /admin/worlds`, `POST /admin/tokens`, `POST /admin/lease/release` and `GET /admin/status`
  - `admin` (the router)

- [ ] **Step 1: Write the failing test**

`apps/worker/test/admin.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/auth";
import { claimLease } from "../src/lease";
import { addUser, call, worldFiles } from "./helpers";

async function createWorld(name: string, extra: Record<string, unknown> = {}) {
  const { profile, lockfile } = await worldFiles();
  return call("POST", "/admin/worlds", { admin: true, body: { name, profile, lockfile, ...extra } });
}
const worldRow = (name: string) =>
  env.DB.prepare("SELECT * FROM worlds WHERE name = ?").bind(name).first<{ id: string; status: string; pregen_done: number }>();

describe("POST /admin/worlds", () => {
  it("creates the active world from a matching profile and lockfile", async () => {
    const r = await createWorld("adventure-1");
    expect(r.status).toBe(201);
    expect(r.body.name).toBe("adventure-1");
    expect((await worldRow("adventure-1"))?.status).toBe("active");
    expect((await worldRow("adventure-1"))?.pregen_done).toBe(0);
  });

  it("marks imported worlds as already pre-generated", async () => {
    await createWorld("imported-1", { imported: true });
    expect((await worldRow("imported-1"))?.pregen_done).toBe(1);
  });

  it("rejects a lockfile that doesn't match the profile", async () => {
    const { profile, lockfile } = await worldFiles();
    const r = await call("POST", "/admin/worlds", {
      admin: true,
      body: { name: "w", profile, lockfile: { ...lockfile, profileHash: "0".repeat(64) } },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("doesn't match");
  });

  it("refuses a second active world without --replace, and duplicate names", async () => {
    await createWorld("first");
    const second = await createWorld("second");
    expect(second.status).toBe(409);
    expect(second.body.message).toContain("--replace");
    const dup = await createWorld("first", { replace: true });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toContain("already exists");
  });

  it("--replace archives the old world down to its latest snapshot", async () => {
    await createWorld("old");
    const old = (await worldRow("old"))!;
    for (const rev of [1, 2, 3]) {
      const key = `worlds/${old.id}/${rev}-x.zip`;
      await env.BUCKET.put(key, "zip");
      await env.DB.prepare("INSERT INTO snapshots VALUES (?, ?, ?, 3, 'x', 'a', ?)").bind(old.id, rev, key, rev).run();
    }
    const r = await createWorld("new", { replace: true });
    expect(r.status).toBe(201);
    expect((await worldRow("old"))?.status).toBe("archived");
    expect((await worldRow("new"))?.status).toBe("active");
    const revs = await env.DB.prepare("SELECT rev FROM snapshots WHERE world_id = ?").bind(old.id).all<{ rev: number }>();
    expect(revs.results.map((x) => x.rev)).toEqual([3]);
    const listed = await env.BUCKET.list({ prefix: `worlds/${old.id}/` });
    expect(listed.objects.map((o) => o.key)).toEqual([`worlds/${old.id}/3-x.zip`]);
  });

  it("--replace fails while someone holds the lease", async () => {
    await createWorld("busy");
    await addUser("100000000000000001", "Alex");
    await claimLease(env.DB, { userId: "100000000000000001", hostAddress: "100.64.0.3", worldId: (await worldRow("busy"))!.id, now: Date.now() });
    const r = await createWorld("next", { replace: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("lease_held");
    expect(await worldRow("next")).toBeNull();
  });

  it("needs the admin secret", async () => {
    const token = await addUser();
    const { profile, lockfile } = await worldFiles();
    const r = await call("POST", "/admin/worlds", { token, body: { name: "x", profile, lockfile } });
    expect(r.status).toBe(401);
  });
});

describe("tokens, lease release and status", () => {
  it("mints a token that is stored only as a hash, and re-minting replaces it", async () => {
    const a = await call("POST", "/admin/tokens", { admin: true, body: { discordId: "123456789012345678", name: "Sam" } });
    expect(a.status).toBe(201);
    const row = () => env.DB.prepare("SELECT token_hash FROM users WHERE discord_id = '123456789012345678'").first<{ token_hash: string }>();
    expect((await row())?.token_hash).toBe(await hashToken(a.body.token));
    const b = await call("POST", "/admin/tokens", { admin: true, body: { discordId: "123456789012345678", name: "Sam" } });
    expect(b.body.token).not.toBe(a.body.token);
    expect((await row())?.token_hash).toBe(await hashToken(b.body.token));
  });

  it("releases a held lease and reports who had it", async () => {
    await createWorld("w");
    await addUser("100000000000000001", "Alex");
    await claimLease(env.DB, { userId: "100000000000000001", hostAddress: "100.64.0.3", worldId: (await worldRow("w"))!.id, now: Date.now() });
    const r = await call("POST", "/admin/lease/release", { admin: true });
    expect(r.body.released).toMatchObject({ name: "Alex", hostAddress: "100.64.0.3" });
    expect((await call("POST", "/admin/lease/release", { admin: true })).body.released).toBeNull();
  });

  it("reports the active world, lease and users", async () => {
    await createWorld("w");
    await addUser("100000000000000001", "Alex");
    const r = await call("GET", "/admin/status", { admin: true });
    expect(r.status).toBe(200);
    expect(r.body.world).toMatchObject({ name: "w", minecraft: "26.3", latestRev: 0, latestAt: null, pregenDone: false });
    expect(r.body.lease).toBeNull();
    expect(r.body.users).toEqual([{ discordId: "100000000000000001", name: "Alex", revoked: false }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/admin.vitest.ts`
Expected: FAIL with 404s, because `/admin` isn't mounted yet.

- [ ] **Step 3: Implement worlds, users and the admin router**

`apps/worker/src/worlds.ts`:
```ts
import { parseLock, parseProfile, profileHash, serializeLock, type Lockfile, type Profile } from "@mc/profile";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { isHeld, leaseInfo, readLease } from "./lease";

export interface WorldRow {
  id: string;
  name: string;
  mc_version: string;
  profile_json: string;
  lockfile_json: string;
  status: "active" | "archived";
  pregen_done: number;
  created_at: number;
}

export interface SnapshotRow {
  world_id: string;
  rev: number;
  r2_key: string;
  size: number;
  sha256: string;
  uploaded_by: string;
  created_at: number;
}

const MAX_WORLD_FILES_BYTES = 1_000_000;

export const activeWorld = (db: D1Database) => db.prepare("SELECT * FROM worlds WHERE status = 'active'").first<WorldRow>();

export async function requireActiveWorld(db: D1Database): Promise<WorldRow> {
  const w = await activeWorld(db);
  if (!w) throw new ApiError("no_active_world", "No world is active yet. A maintainer runs `mc-host admin world create <profile>`.");
  return w;
}

export const latestSnapshot = (db: D1Database, worldId: string) =>
  db.prepare("SELECT * FROM snapshots WHERE world_id = ? ORDER BY rev DESC LIMIT 1").bind(worldId).first<SnapshotRow>();

/** Parse both files with the same code the agent uses, and check that they belong together. */
export async function validateWorldFiles(rawProfile: unknown, rawLock: unknown): Promise<{ profile: Profile; lock: Lockfile }> {
  let profile: Profile;
  let lock: Lockfile;
  try {
    profile = parseProfile(rawProfile, "profile");
    lock = parseLock(JSON.stringify(rawLock), "lockfile");
  } catch (err) {
    throw new ApiError("bad_request", (err as Error).message);
  }
  if (lock.profile !== profile.name || lock.profileHash !== (await profileHash(profile))) {
    throw new ApiError(
      "bad_request",
      `The lockfile doesn't match the ${profile.name} profile. Run "mc-host profile resolve ${profile.name}" and try again.`,
    );
  }
  if (JSON.stringify(profile).length + serializeLock(lock).length > MAX_WORLD_FILES_BYTES) {
    throw new ApiError("bad_request", "The profile and lockfile are over 1 MB together, which is far more than any real profile.");
  }
  return { profile, lock };
}

export async function createWorld(
  env: Pick<Env, "DB" | "BUCKET">,
  o: { name: string; profile: Profile; lock: Lockfile; replace: boolean; imported: boolean; now: number },
): Promise<{ id: string; name: string }> {
  const db = env.DB;
  if (await db.prepare("SELECT 1 FROM worlds WHERE name = ?").bind(o.name).first()) {
    throw new ApiError("conflict", `A world called "${o.name}" already exists. Pick another name with --name.`);
  }
  const current = await activeWorld(db);
  if (current) {
    if (!o.replace) {
      throw new ApiError("conflict", `"${current.name}" is the active world. Add --replace to archive it and start "${o.name}".`);
    }
    const lease = await readLease(db);
    if (isHeld(lease, o.now)) {
      throw new ApiError(
        "lease_held",
        `Someone is hosting "${current.name}" right now. Wait for them to stop, or run "mc-host admin lease release" first.`,
        leaseInfo(lease),
      );
    }
  }
  const id = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [];
  if (current) stmts.push(db.prepare("UPDATE worlds SET status = 'archived' WHERE id = ?").bind(current.id));
  stmts.push(
    db
      .prepare(
        "INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
      )
      .bind(id, o.name, o.lock.minecraft, JSON.stringify(o.profile), serializeLock(o.lock), o.imported ? 1 : 0, o.now),
  );
  await db.batch(stmts);
  if (current) await pruneWorld(env, current.id, 1);
  return { id, name: o.name };
}

/** "worlds/<id>/<rev>-<uuid>.zip" → rev. Unknown shapes are never treated as prunable. */
export function revOfKey(key: string): number {
  const m = /\/(\d+)-[^/]+\.zip$/.exec(key);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((obj) => obj.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * Keep the newest `keep` snapshots. Also delete abandoned uploads, meaning objects with no row
 * whose rev is at or below the latest. Objects above the latest rev may be an upload in flight
 * and are left alone.
 */
export async function pruneWorld(env: Pick<Env, "DB" | "BUCKET">, worldId: string, keep: number): Promise<void> {
  const rows = (
    await env.DB.prepare("SELECT rev, r2_key FROM snapshots WHERE world_id = ? ORDER BY rev DESC")
      .bind(worldId)
      .all<{ rev: number; r2_key: string }>()
  ).results;
  const kept = rows.slice(0, keep);
  const dropped = rows.slice(keep);
  const latestRev = rows[0]?.rev ?? 0;
  const keptKeys = new Set(kept.map((r) => r.r2_key));
  const orphans = (await listKeys(env.BUCKET, `worlds/${worldId}/`)).filter(
    (k) => !keptKeys.has(k) && revOfKey(k) <= latestRev,
  );
  if (dropped.length) {
    await env.DB.prepare("DELETE FROM snapshots WHERE world_id = ? AND rev < ?").bind(worldId, kept.at(-1)!.rev).run();
  }
  const doomed = [...new Set([...dropped.map((r) => r.r2_key), ...orphans])];
  if (doomed.length) await env.BUCKET.delete(doomed);
}
```

`apps/worker/src/users.ts`:
```ts
import { hashToken } from "./auth";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Create or update the user and return a fresh token. Only its hash is stored. */
export async function mintToken(db: D1Database, discordId: string, name: string, now: number): Promise<string> {
  const token = randomToken();
  await db
    .prepare(
      `INSERT INTO users (discord_id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (discord_id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, revoked_at = NULL`,
    )
    .bind(discordId, name, await hashToken(token), now)
    .run();
  return token;
}

export async function listUsers(db: D1Database): Promise<{ discordId: string; name: string; revoked: boolean }[]> {
  const rows = await db
    .prepare("SELECT discord_id, name, revoked_at FROM users ORDER BY name")
    .all<{ discord_id: string; name: string; revoked_at: number | null }>();
  return rows.results.map((r) => ({ discordId: r.discord_id, name: r.name, revoked: r.revoked_at !== null }));
}
```

`apps/worker/src/routes/admin.ts`:
```ts
import {
  CreateWorldRequestSchema,
  MintTokenRequestSchema,
  type AdminStatus,
  type CreateWorldResponse,
  type MintTokenResponse,
  type ReleaseResponse,
} from "@mc/protocol";
import { Hono } from "hono";
import { adminAuth } from "../auth";
import type { AppEnv } from "../env";
import { readBody } from "../errors";
import { forceRelease, isHeld, leaseInfo, readLease } from "../lease";
import { listUsers, mintToken } from "../users";
import { activeWorld, createWorld, latestSnapshot, validateWorldFiles } from "../worlds";

export const admin = new Hono<AppEnv>();
admin.use("*", adminAuth);

admin.post("/worlds", async (c) => {
  const req = await readBody(c, CreateWorldRequestSchema);
  const { profile, lock } = await validateWorldFiles(req.profile, req.lockfile);
  const world: CreateWorldResponse = await createWorld(c.env, {
    name: req.name,
    profile,
    lock,
    replace: req.replace,
    imported: req.imported,
    now: Date.now(),
  });
  return c.json(world, 201);
});

admin.post("/tokens", async (c) => {
  const req = await readBody(c, MintTokenRequestSchema);
  const body: MintTokenResponse = { token: await mintToken(c.env.DB, req.discordId, req.name, Date.now()) };
  return c.json(body, 201);
});

admin.post("/lease/release", async (c) => {
  const body: ReleaseResponse = { released: await forceRelease(c.env.DB, Date.now()) };
  return c.json(body);
});

admin.get("/status", async (c) => {
  const now = Date.now();
  const world = await activeWorld(c.env.DB);
  const latest = world ? await latestSnapshot(c.env.DB, world.id) : null;
  const lease = await readLease(c.env.DB);
  const body: AdminStatus = {
    world: world
      ? {
          id: world.id,
          name: world.name,
          minecraft: world.mc_version,
          latestRev: latest?.rev ?? 0,
          latestAt: latest?.created_at ?? null,
          pregenDone: world.pregen_done === 1,
        }
      : null,
    lease: isHeld(lease, now) ? leaseInfo(lease) : null,
    users: await listUsers(c.env.DB),
  };
  return c.json(body);
});
```

In `apps/worker/src/index.ts`: add `import { admin } from "./routes/admin";` and, above the `// routers` comment, `app.route("/admin", admin);`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/worker && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -F - <<'EOF'
feat(worker): admin API for worlds, tokens, lease release and status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 6: Agent routes for the manifest and the lease

**Files:**
- Create: `apps/worker/src/routes/agent.ts`
- Modify: `apps/worker/src/index.ts` (mount `/agent`)
- Test: `apps/worker/test/agent.vitest.ts`

**Interfaces:**
- Consumes:
  - `agentAuth`
  - `requireActiveWorld` and `latestSnapshot`
  - `claimLease`, `heartbeatLease`, `releaseLease`, `readLease`, `isHeld` and `leaseInfo`
  - `storageFor`
  - `ClaimRequestSchema`, `SessionRequestSchema`, `Manifest`, `ClaimResponse`, `HeartbeatResponse` and `Ok` from `@mc/protocol`
- Produces:
  - routes `GET /agent/manifest`, `POST /agent/lease/claim`, `POST /agent/lease/heartbeat` and `POST /agent/lease/release`
  - `agent` (the router). Task 7 adds the snapshot routes to it.

- [ ] **Step 1: Write the failing test**

`apps/worker/test/agent.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { addUser, call, worldFiles } from "./helpers";

let alex: string;
let sam: string;
beforeEach(async () => {
  alex = await addUser("100000000000000001", "Alex");
  sam = await addUser("100000000000000002", "Sam");
});
async function makeWorld(name = "w") {
  const { profile, lockfile } = await worldFiles();
  return (await call("POST", "/admin/worlds", { admin: true, body: { name, profile, lockfile } })).body as { id: string };
}
const claim = (token: string, hostAddress = "100.64.0.3") => call("POST", "/agent/lease/claim", { token, body: { hostAddress } });

describe("GET /agent/manifest", () => {
  it("says no world is active, in the spec's words", async () => {
    const r = await call("GET", "/agent/manifest", { token: alex });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      error: "no_active_world",
      message: "No world is active yet. A maintainer runs `mc-host admin world create <profile>`.",
    });
  });

  it("describes a fresh world with its pinned files", async () => {
    const { id } = await makeWorld("fresh");
    const { profile, lockfile } = await worldFiles();
    const r = await call("GET", "/agent/manifest", { token: alex });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      world: { id, name: "fresh", minecraft: "26.3" },
      profile: JSON.parse(JSON.stringify(profile)),
      lockfile: JSON.parse(JSON.stringify(lockfile)),
      pregenDone: false,
      latest: null,
      lease: null,
    });
  });

  it("links the latest snapshot and shows the lease from each side", async () => {
    const { id } = await makeWorld();
    await env.BUCKET.put(`worlds/${id}/1-a.zip`, "zip");
    await env.DB.prepare("INSERT INTO snapshots VALUES (?, 1, ?, 3, ?, 'x', 1)").bind(id, `worlds/${id}/1-a.zip`, "b".repeat(64)).run();
    await claim(alex);
    const mine = await call("GET", "/agent/manifest", { token: alex });
    expect(mine.body.latest).toMatchObject({ rev: 1, size: 3, sha256: "b".repeat(64) });
    expect(mine.body.latest.url).toBe(`http://localhost/dev/r2/worlds/${id}/1-a.zip`);
    expect(mine.body.lease).toMatchObject({ name: "Alex", hostAddress: "100.64.0.3", you: true });
    expect((await call("GET", "/agent/manifest", { token: sam })).body.lease.you).toBe(false);
  });
});

describe("lease routes", () => {
  it("claim, heartbeat and release over HTTP", async () => {
    await makeWorld();
    const c = await claim(alex);
    expect(c.status).toBe(200);
    expect(c.body.baseRev).toBe(0);
    const hb = await call("POST", "/agent/lease/heartbeat", { token: alex, body: { sessionId: c.body.sessionId } });
    expect(hb.status).toBe(200);
    expect(hb.body.expiresAt).toBeGreaterThan(Date.now());
    const rel = await call("POST", "/agent/lease/release", { token: alex, body: { sessionId: c.body.sessionId } });
    expect(rel.body).toEqual({ ok: true });
  });

  it("a second claimer gets lease_held with the holder", async () => {
    await makeWorld();
    await claim(alex);
    const r = await claim(sam, "100.64.0.9");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("lease_held");
    expect(r.body.holder).toMatchObject({ name: "Alex", hostAddress: "100.64.0.3" });
  });

  it("a stale session's heartbeat gets lease_lost", async () => {
    await makeWorld();
    const first = await claim(alex);
    await claim(alex, "100.64.0.7");
    const hb = await call("POST", "/agent/lease/heartbeat", { token: alex, body: { sessionId: first.body.sessionId } });
    expect(hb.status).toBe(409);
    expect(hb.body.error).toBe("lease_lost");
  });

  it("claim needs an active world and a valid body", async () => {
    expect((await claim(alex)).body.error).toBe("no_active_world");
    await makeWorld();
    const bad = await call("POST", "/agent/lease/claim", { token: alex, body: { hostAddress: "" } });
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/agent.vitest.ts`
Expected: FAIL with 404 `not_found`, because `/agent` isn't mounted yet.

- [ ] **Step 3: Implement the agent router**

`apps/worker/src/routes/agent.ts`:
```ts
import {
  ClaimRequestSchema,
  SessionRequestSchema,
  type ClaimResponse,
  type HeartbeatResponse,
  type Manifest,
  type Ok,
} from "@mc/protocol";
import { Hono } from "hono";
import { agentAuth } from "../auth";
import type { AppEnv } from "../env";
import { readBody } from "../errors";
import { claimLease, heartbeatLease, isHeld, leaseInfo, readLease, releaseLease } from "../lease";
import { storageFor } from "../storage";
import { latestSnapshot, requireActiveWorld } from "../worlds";

export const agent = new Hono<AppEnv>();
agent.use("*", agentAuth);

agent.get("/manifest", async (c) => {
  const db = c.env.DB;
  const world = await requireActiveWorld(db);
  const latest = await latestSnapshot(db, world.id);
  const lease = await readLease(db);
  const body: Manifest = {
    world: { id: world.id, name: world.name, minecraft: world.mc_version },
    profile: JSON.parse(world.profile_json),
    lockfile: JSON.parse(world.lockfile_json),
    pregenDone: world.pregen_done === 1,
    latest: latest
      ? { rev: latest.rev, sha256: latest.sha256, size: latest.size, url: await storageFor(c.env, c.req.url).getUrl(latest.r2_key) }
      : null,
    lease: isHeld(lease, Date.now()) ? { ...leaseInfo(lease), you: lease.holder_id === c.var.userId } : null,
  };
  return c.json(body);
});

agent.post("/lease/claim", async (c) => {
  const { hostAddress } = await readBody(c, ClaimRequestSchema);
  const world = await requireActiveWorld(c.env.DB);
  const body: ClaimResponse = await claimLease(c.env.DB, { userId: c.var.userId, hostAddress, worldId: world.id, now: Date.now() });
  return c.json(body);
});

agent.post("/lease/heartbeat", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  const body: HeartbeatResponse = { expiresAt: await heartbeatLease(c.env.DB, sessionId, Date.now()) };
  return c.json(body);
});

agent.post("/lease/release", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  await releaseLease(c.env.DB, sessionId);
  const body: Ok = { ok: true };
  return c.json(body);
});
```

In `apps/worker/src/index.ts`: add `import { agent } from "./routes/agent";` and `app.route("/agent", agent);` next to the admin mount.

- [ ] **Step 4: Run the tests**

Run: `cd apps/worker && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -F - <<'EOF'
feat(worker): agent manifest and lease routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 7: Snapshot upload, commit, retention and import

**Files:**
- Create: `apps/worker/src/snapshots.ts`
- Modify: `apps/worker/src/routes/agent.ts` (upload-url, commit), `apps/worker/src/routes/admin.ts` (import-url, import-commit)
- Test: `apps/worker/test/snapshots.vitest.ts`

**Interfaces:**
- Consumes:
  - `storageFor`
  - `latestSnapshot`, `pruneWorld` and `WorldRow`
  - `requireSession`, `readLease`, `isHeld`, `leaseInfo` and `leaseLostError`
  - `UploadUrlRequestSchema`, `CommitRequestSchema`, `ImportUrlRequestSchema`, `ImportCommitRequestSchema`, `UploadTarget` and `CommitResponse` from `@mc/protocol`
- Produces:
  - `KEEP_SNAPSHOTS = 5`
  - `snapshotKey(worldId, rev)`
  - `beginUpload(env, requestUrl, {worldId, baseRev, sha256}): Promise<UploadTarget>`
  - `commitSnapshot(env, {worldId, rev, key, size, sha256, uploadedBy, now, pregenDone?, sessionId: string | null}): Promise<void>`
  - routes `POST /agent/snapshot/upload-url`, `POST /agent/snapshot/commit`, `POST /admin/worlds/:id/import-url` and `POST /admin/worlds/:id/import-commit`

- [ ] **Step 1: Write the failing test**

`apps/worker/test/snapshots.vitest.ts`:
```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { readLease } from "../src/lease";
import { addUser, call, worldFiles } from "./helpers";

let alex: string;
let worldId: string;
const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(async () => {
  alex = await addUser("100000000000000001", "Alex");
  const { profile, lockfile } = await worldFiles();
  worldId = (await call("POST", "/admin/worlds", { admin: true, body: { name: "w", profile, lockfile } })).body.id;
});

async function claim(): Promise<string> {
  return (await call("POST", "/agent/lease/claim", { token: alex, body: { hostAddress: "100.64.0.3" } })).body.sessionId;
}

/** upload-url → PUT through the dev proxy → commit. Returns the commit response. */
async function save(sessionId: string, baseRev: number, data: Uint8Array, extra: Record<string, unknown> = {}) {
  const sha256 = await hex(data);
  const target = await call("POST", "/agent/snapshot/upload-url", { token: alex, body: { sessionId, baseRev, size: data.length, sha256 } });
  expect(target.status).toBe(200);
  const put = await app.request(target.body.url, { method: "PUT", headers: target.body.headers, body: data }, env);
  expect(put.status).toBe(200);
  return call("POST", "/agent/snapshot/commit", {
    token: alex,
    body: { sessionId, rev: target.body.rev, key: target.body.key, size: data.length, sha256, ...extra },
  });
}

describe("upload and commit", () => {
  it("commits rev 1 and serves it through the manifest", async () => {
    const s = await claim();
    const r = await save(s, 0, bytes("rev one"));
    expect(r.body).toEqual({ rev: 1 });
    expect((await readLease(env.DB)).base_rev).toBe(1);
    const m = await call("GET", "/agent/manifest", { token: alex });
    expect(m.body.latest).toMatchObject({ rev: 1, size: 7, sha256: await hex(bytes("rev one")) });
    const got = await app.request(m.body.latest.url, {}, env);
    expect(await got.text()).toBe("rev one");
  });

  it("refuses an upload URL for a stale base rev", async () => {
    const s = await claim();
    await save(s, 0, bytes("a"));
    const r = await call("POST", "/agent/snapshot/upload-url", {
      token: alex,
      body: { sessionId: s, baseRev: 0, size: 1, sha256: "a".repeat(64) },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("stale_rev");
  });

  it("refuses a commit whose rev skips ahead", async () => {
    const s = await claim();
    const data = bytes("x");
    const key = `worlds/${worldId}/2-skip.zip`;
    await env.BUCKET.put(key, data);
    const r = await call("POST", "/agent/snapshot/commit", {
      token: alex,
      body: { sessionId: s, rev: 2, key, size: 1, sha256: await hex(data) },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("stale_rev");
  });

  it("refuses a commit when the object is missing, short, or not this world's", async () => {
    const s = await claim();
    const sha = "c".repeat(64);
    const missing = await call("POST", "/agent/snapshot/commit", {
      token: alex,
      body: { sessionId: s, rev: 1, key: `worlds/${worldId}/1-none.zip`, size: 5, sha256: sha },
    });
    expect(missing.body.error).toBe("upload_missing");
    await env.BUCKET.put(`worlds/${worldId}/1-short.zip`, "abc");
    const short = await call("POST", "/agent/snapshot/commit", {
      token: alex,
      body: { sessionId: s, rev: 1, key: `worlds/${worldId}/1-short.zip`, size: 5, sha256: sha },
    });
    expect(short.body.error).toBe("upload_missing");
    const foreign = await call("POST", "/agent/snapshot/commit", {
      token: alex,
      body: { sessionId: s, rev: 1, key: "worlds/other/1-x.zip", size: 5, sha256: sha },
    });
    expect(foreign.status).toBe(400);
  });

  it("refuses a stale session", async () => {
    const s = await claim();
    await call("POST", "/admin/lease/release", { admin: true });
    const r = await call("POST", "/agent/snapshot/upload-url", {
      token: alex,
      body: { sessionId: s, baseRev: 0, size: 1, sha256: "a".repeat(64) },
    });
    expect(r.body.error).toBe("lease_lost");
  });

  it("records pre-generation when reported", async () => {
    const s = await claim();
    await save(s, 0, bytes("a"), { pregenDone: true });
    const row = await env.DB.prepare("SELECT pregen_done FROM worlds WHERE id = ?").bind(worldId).first<{ pregen_done: number }>();
    expect(row?.pregen_done).toBe(1);
  });
});

describe("retention", () => {
  it("keeps the newest 5 snapshots and removes abandoned uploads, but not in-flight ones", async () => {
    const s = await claim();
    await save(s, 0, bytes("1"));
    await save(s, 1, bytes("2"));
    await env.BUCKET.put(`worlds/${worldId}/1-orphan.zip`, "o");
    await env.BUCKET.put(`worlds/${worldId}/9-inflight.zip`, "f");
    for (let rev = 2; rev < 7; rev++) await save(s, rev, bytes(String(rev + 1)));
    const revs = await env.DB.prepare("SELECT rev FROM snapshots WHERE world_id = ? ORDER BY rev").bind(worldId).all<{ rev: number }>();
    expect(revs.results.map((r) => r.rev)).toEqual([3, 4, 5, 6, 7]);
    const keys = (await env.BUCKET.list({ prefix: `worlds/${worldId}/` })).objects.map((o) => o.key);
    expect(keys).toHaveLength(6);
    expect(keys).toContain(`worlds/${worldId}/9-inflight.zip`);
    expect(keys).not.toContain(`worlds/${worldId}/1-orphan.zip`);
  });
});

describe("import", () => {
  async function importData(data: Uint8Array) {
    const sha256 = await hex(data);
    const t = await call("POST", `/admin/worlds/${worldId}/import-url`, { admin: true, body: { size: data.length, sha256 } });
    if (t.status !== 200) return t;
    await app.request(t.body.url, { method: "PUT", headers: t.body.headers, body: data }, env);
    return call("POST", `/admin/worlds/${worldId}/import-commit`, {
      admin: true,
      body: { key: t.body.key, size: data.length, sha256 },
    });
  }

  it("imports a zip as rev 1, once", async () => {
    expect((await importData(bytes("old world"))).body).toEqual({ rev: 1 });
    const again = await importData(bytes("again"));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("conflict");
  });

  it("refuses to import while someone hosts", async () => {
    await claim();
    const r = await importData(bytes("x"));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("lease_held");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/snapshots.vitest.ts`
Expected: FAIL with 404 `not_found` on the snapshot routes.

- [ ] **Step 3: Implement snapshots and the routes**

`apps/worker/src/snapshots.ts`:
```ts
import type { UploadTarget } from "@mc/protocol";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { leaseLostError, readLease } from "./lease";
import { storageFor } from "./storage";
import { latestSnapshot, pruneWorld } from "./worlds";

export const KEEP_SNAPSHOTS = 5;

export const snapshotKey = (worldId: string, rev: number) => `worlds/${worldId}/${rev}-${crypto.randomUUID()}.zip`;

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function beginUpload(
  env: Env,
  requestUrl: string,
  o: { worldId: string; baseRev: number; sha256: string },
): Promise<UploadTarget> {
  const latest = (await latestSnapshot(env.DB, o.worldId))?.rev ?? 0;
  if (o.baseRev !== latest) {
    throw new ApiError("stale_rev", `This copy of the world is at rev ${o.baseRev}, but the latest is rev ${latest}.`);
  }
  const rev = latest + 1;
  const key = snapshotKey(o.worldId, rev);
  return { rev, key, ...(await storageFor(env, requestUrl).putTarget(key, o.sha256)) };
}

async function verifyObject(bucket: R2Bucket, o: { worldId: string; rev: number; key: string; size: number; sha256: string }) {
  if (!o.key.startsWith(`worlds/${o.worldId}/${o.rev}-`) || !o.key.endsWith(".zip")) {
    throw new ApiError("bad_request", "That upload key doesn't belong to this world and rev.");
  }
  const head = await bucket.head(o.key);
  if (!head) throw new ApiError("upload_missing", "The upload didn't reach storage. Upload it again.");
  if (head.size !== o.size) {
    throw new ApiError("upload_missing", `The upload is incomplete (${head.size} of ${o.size} bytes). Upload it again.`);
  }
  const sum = head.checksums.sha256;
  if (sum && toHex(sum) !== o.sha256) throw new ApiError("upload_missing", "The upload doesn't match its sha256. Upload it again.");
}

/**
 * Record an uploaded snapshot. With a sessionId, only that session may commit (agent). With
 * null, only while nobody holds the lease (admin import). Either way the rev must be exactly
 * latest + 1. Both checks run inside the INSERT, so a race can't fork the world.
 */
export async function commitSnapshot(
  env: Env,
  o: {
    worldId: string;
    rev: number;
    key: string;
    size: number;
    sha256: string;
    uploadedBy: string;
    now: number;
    pregenDone?: boolean;
    sessionId: string | null;
  },
): Promise<void> {
  await verifyObject(env.BUCKET, o);
  const db = env.DB;
  const guard =
    o.sessionId === null
      ? "NOT EXISTS (SELECT 1 FROM lease WHERE id = 1 AND holder_id IS NOT NULL AND expires_at >= ?8)"
      : "EXISTS (SELECT 1 FROM lease WHERE id = 1 AND session_id = ?8)";
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE ${guard} AND (SELECT COALESCE(MAX(rev), 0) FROM snapshots WHERE world_id = ?1) = ?2 - 1`,
      )
      .bind(o.worldId, o.rev, o.key, o.size, o.sha256, o.uploadedBy, o.now, o.sessionId ?? o.now),
    db
      .prepare(
        "UPDATE lease SET base_rev = ?1 WHERE id = 1 AND session_id = ?2 AND EXISTS (SELECT 1 FROM snapshots WHERE world_id = ?3 AND rev = ?1 AND r2_key = ?4)",
      )
      .bind(o.rev, o.sessionId, o.worldId, o.key),
    db
      .prepare(
        "UPDATE worlds SET pregen_done = 1 WHERE id = ?1 AND ?2 = 1 AND EXISTS (SELECT 1 FROM snapshots WHERE world_id = ?1 AND rev = ?3 AND r2_key = ?4)",
      )
      .bind(o.worldId, o.pregenDone ? 1 : 0, o.rev, o.key),
  ]);
  if (results[0]!.meta.changes !== 1) {
    if (o.sessionId !== null && (await readLease(db)).session_id !== o.sessionId) throw leaseLostError();
    throw new ApiError("stale_rev", `Rev ${o.rev} can't be committed because the world has moved on.`);
  }
  await pruneWorld(env, o.worldId, KEEP_SNAPSHOTS);
}
```

Add to `apps/worker/src/routes/agent.ts`. Merge these into the existing import lines: `UploadUrlRequestSchema`, `CommitRequestSchema`, `type UploadTarget` and `type CommitResponse` from `@mc/protocol`; `requireSession` from `../lease`; `beginUpload` and `commitSnapshot` from `../snapshots`. Then append:
```ts
agent.post("/snapshot/upload-url", async (c) => {
  const req = await readBody(c, UploadUrlRequestSchema);
  const lease = await requireSession(c.env.DB, req.sessionId);
  const body: UploadTarget = await beginUpload(c.env, c.req.url, { worldId: lease.world_id, baseRev: req.baseRev, sha256: req.sha256 });
  return c.json(body);
});

agent.post("/snapshot/commit", async (c) => {
  const req = await readBody(c, CommitRequestSchema);
  const lease = await requireSession(c.env.DB, req.sessionId);
  await commitSnapshot(c.env, { ...req, worldId: lease.world_id, uploadedBy: c.var.userId, now: Date.now() });
  const body: CommitResponse = { rev: req.rev };
  return c.json(body);
});
```

Add to `apps/worker/src/routes/admin.ts`. Merge these into the existing import lines: `ImportUrlRequestSchema`, `ImportCommitRequestSchema`, `type UploadTarget` and `type CommitResponse` from `@mc/protocol`; `ApiError` from `../errors`; `beginUpload` and `commitSnapshot` from `../snapshots`; `type WorldRow` from `../worlds`; `type Env` from `../env`. Then append:
```ts
/** Import is only for a brand-new world: active, still at rev 0, with nobody hosting. */
async function importableWorld(env: Env, id: string, now: number): Promise<WorldRow> {
  const world = await env.DB.prepare("SELECT * FROM worlds WHERE id = ?").bind(id).first<WorldRow>();
  if (!world || world.status !== "active") throw new ApiError("not_found", "That world doesn't exist or isn't the active one.");
  if (await latestSnapshot(env.DB, id)) {
    throw new ApiError("conflict", `"${world.name}" already has snapshots, so nothing can be imported into it.`);
  }
  const lease = await readLease(env.DB);
  if (isHeld(lease, now)) throw new ApiError("lease_held", "Someone is hosting right now. Import once they stop.", leaseInfo(lease));
  return world;
}

admin.post("/worlds/:id/import-url", async (c) => {
  const req = await readBody(c, ImportUrlRequestSchema);
  const world = await importableWorld(c.env, c.req.param("id"), Date.now());
  const body: UploadTarget = await beginUpload(c.env, c.req.url, { worldId: world.id, baseRev: 0, sha256: req.sha256 });
  return c.json(body);
});

admin.post("/worlds/:id/import-commit", async (c) => {
  const req = await readBody(c, ImportCommitRequestSchema);
  const now = Date.now();
  const world = await importableWorld(c.env, c.req.param("id"), now);
  await commitSnapshot(c.env, { ...req, worldId: world.id, rev: 1, uploadedBy: "admin", now, sessionId: null });
  const body: CommitResponse = { rev: 1 };
  return c.json(body);
});
```

- [ ] **Step 4: Run all the Worker tests and typecheck**

Run: `cd apps/worker && npx vitest run && npx tsc -p .`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -F - <<'EOF'
feat(worker): snapshot upload/commit with retention, and admin world import

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---
### Task 8: Agent config and the typed Worker client

**Files:**
- Modify: `apps/agent/package.json` (dependencies), `apps/agent/src/paths.ts` (`dataDir`)
- Create: `apps/agent/src/host/config.ts`, `apps/agent/src/host/api.ts`
- Test: `apps/agent/test/host-config.test.ts`, `apps/agent/test/api.test.ts`, `apps/agent/test/paths.test.ts` (extend)

**Interfaces:**
- Consumes: the schemas and types from `@mc/protocol` (Task 1); `UserError` and `Fetch` from `@mc/profile`.
- Produces:
  - `dataDir(env?, platform?, home?): string`
  - `interface HostConfig { workerUrl: string; token: string }` and `loadHostConfig(env, configDir): Promise<HostConfig>`
  - `interface AdminConfig { workerUrl: string; secret: string }` and `loadAdminConfig(env, configDir): Promise<AdminConfig>`
  - error classes, all extending `UserError`: `LeaseHeldError(message, holder)`, `LeaseLostError`, `StaleRevError` and `OfflineError`
  - `hhmm(ms): string`
  - `interface AgentApi { manifest(); claim(hostAddress); heartbeat(sessionId); release(sessionId); uploadUrl(req): Promise<UploadTarget>; commit(req): Promise<number> }`
  - `createAgentApi({workerUrl, token, fetch}): AgentApi`
  - `interface AdminApi { createWorld(req); importUrl(worldId, req); importCommit(worldId, req): Promise<number>; mintToken(req): Promise<string>; releaseLease(): Promise<LeaseInfo | null>; status(): Promise<AdminStatus> }`
  - `createAdminApi({workerUrl, secret, fetch}): AdminApi`

- [ ] **Step 1: Add the dependencies**

In `apps/agent/package.json`, replace the `dependencies` block with:
```json
  "dependencies": {
    "@mc/profile": "workspace:*",
    "@mc/protocol": "workspace:*",
    "fflate": "^0.8.2",
    "zod": "^4.1.0"
  }
```
Run: `bun install`

- [ ] **Step 2: Write the failing tests**

Append to `apps/agent/test/paths.test.ts`. Also add `dataDir` to its existing import from `../src/paths`.
```ts
test("dataDir honours MC_DATA_DIR, then the platform default", () => {
  expect(dataDir({ MC_DATA_DIR: "/data" }, "linux", "/home/a")).toBe("/data");
  expect(dataDir({}, "linux", "/home/a")).toBe("/home/a/.local/share/mc-host/data");
  expect(dataDir({ XDG_DATA_HOME: "/x" }, "linux", "/home/a")).toBe("/x/mc-host/data");
  expect(dataDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a")).toBe(
    "C:\\Users\\a\\AppData\\Local\\mc-host\\data",
  );
});
```

`apps/agent/test/host-config.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdminConfig, loadHostConfig } from "../src/host/config";

const dir = () => mkdtempSync(join(tmpdir(), "mc-hostcfg-"));

test("host config comes from the environment first, then agent.json", async () => {
  const d = dir();
  writeFileSync(join(d, "agent.json"), JSON.stringify({ workerUrl: "https://file.test/", token: "file-token" }));
  expect(await loadHostConfig({}, d)).toEqual({ workerUrl: "https://file.test", token: "file-token" });
  expect(await loadHostConfig({ MC_WORKER_URL: "https://env.test", MC_TOKEN: "env-token" }, d)).toEqual({
    workerUrl: "https://env.test",
    token: "env-token",
  });
});

test("missing host config explains how to set it up", async () => {
  await expect(loadHostConfig({}, dir())).rejects.toThrow("isn't set up to host yet");
});

test("a damaged agent.json is reported", async () => {
  const d = dir();
  writeFileSync(join(d, "agent.json"), "{nope");
  await expect(loadHostConfig({}, d)).rejects.toThrow("is damaged");
});

test("admin config needs a worker URL and the admin secret", async () => {
  const d = dir();
  expect(await loadAdminConfig({ MC_WORKER_URL: "https://w.test", MC_ADMIN_SECRET: "s" }, d)).toEqual({
    workerUrl: "https://w.test",
    secret: "s",
  });
  writeFileSync(join(d, "admin.json"), JSON.stringify({ workerUrl: "https://f.test", secret: "fs" }));
  expect(await loadAdminConfig({}, d)).toEqual({ workerUrl: "https://f.test", secret: "fs" });
  await expect(loadAdminConfig({}, dir())).rejects.toThrow("MC_ADMIN_SECRET");
});
```

`apps/agent/test/api.test.ts`:
```ts
import { expect, test } from "bun:test";
import type { Fetch } from "@mc/profile";
import {
  createAdminApi,
  createAgentApi,
  hhmm,
  LeaseHeldError,
  LeaseLostError,
  OfflineError,
  StaleRevError,
} from "../src/host/api";

type Seen = { url: string; method: string; auth: string | null; body: unknown };
function fakeFetch(reply: (url: string) => Response | Promise<Response>): { fetch: Fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? "GET", auth: headers.get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return reply(url);
  };
  return { fetch, seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SHA = "a".repeat(64);

test("the agent client sends the bearer token and parses replies", async () => {
  const { fetch, seen } = fakeFetch(() => json({ sessionId: "s".repeat(16), baseRev: 3, expiresAt: 9 }));
  const api = createAgentApi({ workerUrl: "https://w.test/", token: "tok", fetch });
  expect(await api.claim("100.64.0.3")).toEqual({ sessionId: "s".repeat(16), baseRev: 3, expiresAt: 9 });
  expect(seen[0]).toEqual({ url: "https://w.test/agent/lease/claim", method: "POST", auth: "Bearer tok", body: { hostAddress: "100.64.0.3" } });
});

test("commit returns the new rev", async () => {
  const { fetch } = fakeFetch(() => json({ rev: 4 }));
  const api = createAgentApi({ workerUrl: "https://w.test", token: "t", fetch });
  expect(await api.commit({ sessionId: "s".repeat(16), rev: 4, key: "k", size: 1, sha256: SHA })).toBe(4);
});

test("lease_held becomes LeaseHeldError with the spec's sentence", async () => {
  const claimedAt = new Date(2026, 8, 26, 20, 14).getTime();
  const { fetch } = fakeFetch(() =>
    json({ error: "lease_held", message: "x", holder: { name: "Alex", hostAddress: "100.64.0.3", claimedAt, expiresAt: 0 } }, 409),
  );
  const api = createAgentApi({ workerUrl: "https://w.test", token: "t", fetch });
  const err = await api.claim("h").catch((e) => e);
  expect(err).toBeInstanceOf(LeaseHeldError);
  expect(err.message).toBe("Alex is already hosting at 100.64.0.3 (since 20:14).");
});

test("lease_lost and stale_rev get their own classes; other codes are plain UserErrors", async () => {
  const reply = (error: string) => fakeFetch(() => json({ error, message: `msg ${error}` }, 409)).fetch;
  const api = (error: string) => createAgentApi({ workerUrl: "https://w.test", token: "t", fetch: reply(error) });
  expect(await api("lease_lost").heartbeat("s".repeat(16)).catch((e) => e)).toBeInstanceOf(LeaseLostError);
  expect(await api("stale_rev").uploadUrl({ sessionId: "s".repeat(16), baseRev: 0, size: 1, sha256: SHA }).catch((e) => e)).toBeInstanceOf(StaleRevError);
  const other = await api("no_active_world").manifest().catch((e) => e);
  expect(other.message).toBe("msg no_active_world");
});

test("network failures and non-JSON errors become OfflineError", async () => {
  const down: Fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const e1 = await createAgentApi({ workerUrl: "https://w.test", token: "t", fetch: down }).manifest().catch((e) => e);
  expect(e1).toBeInstanceOf(OfflineError);
  expect(e1.message).toStartWith("Can't reach the server list at https://w.test.");
  const { fetch } = fakeFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
  expect(await createAgentApi({ workerUrl: "https://w.test", token: "t", fetch }).manifest().catch((e) => e)).toBeInstanceOf(OfflineError);
});

test("the admin client uses the admin secret and unwraps replies", async () => {
  const { fetch, seen } = fakeFetch((url) =>
    url.endsWith("/admin/tokens") ? json({ token: "t".repeat(43) }, 201) : json({ released: null }),
  );
  const api = createAdminApi({ workerUrl: "https://w.test", secret: "sec", fetch });
  expect(await api.mintToken({ discordId: "123456789012345678", name: "Sam" })).toBe("t".repeat(43));
  expect(await api.releaseLease()).toBeNull();
  expect(seen.map((s) => s.auth)).toEqual(["Bearer sec", "Bearer sec"]);
});

test("hhmm pads local hours and minutes", () => {
  expect(hhmm(new Date(2026, 0, 1, 7, 5).getTime())).toBe("07:05");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test apps/agent/test/host-config.test.ts apps/agent/test/api.test.ts apps/agent/test/paths.test.ts`
Expected: FAIL with missing modules, and `dataDir` not exported.

- [ ] **Step 4: Implement**

Append to `apps/agent/src/paths.ts`:
```ts
/** Worlds, local state and recovered copies. MC_DATA_DIR wins (the Docker image sets it to /data). */
export function dataDir(env: Env = process.env, platform: string = process.platform, home = homedir()): string {
  if (env.MC_DATA_DIR) return env.MC_DATA_DIR;
  if (platform === "win32") return win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), "mc-host", "data");
  return posix.join(env.XDG_DATA_HOME ?? posix.join(home, ".local", "share"), "mc-host", "data");
}
```

`apps/agent/src/host/config.ts`:
```ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";

type Env = Record<string, string | undefined>;

export interface HostConfig {
  workerUrl: string;
  token: string;
}

export interface AdminConfig {
  workerUrl: string;
  secret: string;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new UserError(`${path} is damaged. Fix or delete it, then try again.`);
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const trimSlash = (url: string) => url.replace(/\/+$/, "");

export async function loadHostConfig(env: Env, configDir: string): Promise<HostConfig> {
  const path = join(configDir, "agent.json");
  const file = await readJson(path);
  const workerUrl = env.MC_WORKER_URL ?? str(file.workerUrl);
  const token = env.MC_TOKEN ?? str(file.token);
  if (!workerUrl || !token) {
    throw new UserError(
      `This PC isn't set up to host yet. Run the installer again, or put {"workerUrl": "...", "token": "..."} in ${path}.`,
    );
  }
  return { workerUrl: trimSlash(workerUrl), token };
}

export async function loadAdminConfig(env: Env, configDir: string): Promise<AdminConfig> {
  const path = join(configDir, "admin.json");
  const file = await readJson(path);
  const workerUrl = env.MC_WORKER_URL ?? str(file.workerUrl);
  const secret = env.MC_ADMIN_SECRET ?? str(file.secret);
  if (!workerUrl || !secret) {
    throw new UserError(`Admin commands need MC_WORKER_URL and MC_ADMIN_SECRET, or {"workerUrl", "secret"} in ${path}.`);
  }
  return { workerUrl: trimSlash(workerUrl), secret };
}
```

`apps/agent/src/host/api.ts`:
```ts
import { UserError, type Fetch } from "@mc/profile";
import {
  AdminStatusSchema,
  ClaimResponseSchema,
  CommitResponseSchema,
  CreateWorldResponseSchema,
  ErrorBodySchema,
  HeartbeatResponseSchema,
  ManifestSchema,
  MintTokenResponseSchema,
  OkSchema,
  ReleaseResponseSchema,
  UploadTargetSchema,
  type AdminStatus,
  type ClaimResponse,
  type CommitRequest,
  type CreateWorldRequest,
  type CreateWorldResponse,
  type ImportCommitRequest,
  type ImportUrlRequest,
  type LeaseInfo,
  type Manifest,
  type MintTokenRequest,
  type UploadTarget,
  type UploadUrlRequest,
} from "@mc/protocol";
import type { z } from "zod";

/** Someone else holds the lease. */
export class LeaseHeldError extends UserError {
  constructor(
    message: string,
    readonly holder: LeaseInfo,
  ) {
    super(message);
  }
}
/** This session's lease is gone: another claim rotated it, or a maintainer released it. */
export class LeaseLostError extends UserError {}
/** The world moved on past this copy's base rev. */
export class StaleRevError extends UserError {}
/** The Worker couldn't be reached, or answered with something that isn't our API. */
export class OfflineError extends UserError {}

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Client {
  fetch: Fetch;
  base: string;
  secret: string;
}

async function request<T>(c: Client, method: "GET" | "POST", path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await c.fetch(`${c.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${c.secret}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new OfflineError(
      `Can't reach the server list at ${c.base}. Check your internet connection and try again. (${(err as Error).message})`,
    );
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (res.ok) {
    const parsed = schema.safeParse(data);
    if (parsed.success) return parsed.data;
    throw new UserError(`The server list sent a reply this version of mc-host doesn't understand (${path}). Update mc-host.`);
  }
  const err = ErrorBodySchema.safeParse(data);
  if (!err.success) {
    throw new OfflineError(`The server list at ${c.base} answered HTTP ${res.status}. Try again in a few minutes.`);
  }
  const { error, message, holder } = err.data;
  if (error === "lease_held" && holder) {
    throw new LeaseHeldError(`${holder.name} is already hosting at ${holder.hostAddress} (since ${hhmm(holder.claimedAt)}).`, holder);
  }
  if (error === "lease_lost") throw new LeaseLostError(message);
  if (error === "stale_rev") throw new StaleRevError(message);
  throw new UserError(message);
}

export interface AgentApi {
  manifest(): Promise<Manifest>;
  claim(hostAddress: string): Promise<ClaimResponse>;
  heartbeat(sessionId: string): Promise<void>;
  release(sessionId: string): Promise<void>;
  uploadUrl(req: UploadUrlRequest): Promise<UploadTarget>;
  /** Returns the committed rev. */
  commit(req: CommitRequest): Promise<number>;
}

export function createAgentApi(o: { workerUrl: string; token: string; fetch: Fetch }): AgentApi {
  const c: Client = { fetch: o.fetch, base: o.workerUrl.replace(/\/+$/, ""), secret: o.token };
  return {
    manifest: () => request(c, "GET", "/agent/manifest", ManifestSchema),
    claim: (hostAddress) => request(c, "POST", "/agent/lease/claim", ClaimResponseSchema, { hostAddress }),
    heartbeat: async (sessionId) => {
      await request(c, "POST", "/agent/lease/heartbeat", HeartbeatResponseSchema, { sessionId });
    },
    release: async (sessionId) => {
      await request(c, "POST", "/agent/lease/release", OkSchema, { sessionId });
    },
    uploadUrl: (req) => request(c, "POST", "/agent/snapshot/upload-url", UploadTargetSchema, req),
    commit: async (req) => (await request(c, "POST", "/agent/snapshot/commit", CommitResponseSchema, req)).rev,
  };
}

export interface AdminApi {
  createWorld(req: CreateWorldRequest): Promise<CreateWorldResponse>;
  importUrl(worldId: string, req: ImportUrlRequest): Promise<UploadTarget>;
  importCommit(worldId: string, req: ImportCommitRequest): Promise<number>;
  mintToken(req: MintTokenRequest): Promise<string>;
  releaseLease(): Promise<LeaseInfo | null>;
  status(): Promise<AdminStatus>;
}

export function createAdminApi(o: { workerUrl: string; secret: string; fetch: Fetch }): AdminApi {
  const c: Client = { fetch: o.fetch, base: o.workerUrl.replace(/\/+$/, ""), secret: o.secret };
  return {
    createWorld: (req) => request(c, "POST", "/admin/worlds", CreateWorldResponseSchema, req),
    importUrl: (id, req) => request(c, "POST", `/admin/worlds/${encodeURIComponent(id)}/import-url`, UploadTargetSchema, req),
    importCommit: async (id, req) =>
      (await request(c, "POST", `/admin/worlds/${encodeURIComponent(id)}/import-commit`, CommitResponseSchema, req)).rev,
    mintToken: async (req) => (await request(c, "POST", "/admin/tokens", MintTokenResponseSchema, req)).token,
    releaseLease: async () => (await request(c, "POST", "/admin/lease/release", ReleaseResponseSchema, {})).released,
    status: () => request(c, "GET", "/admin/status", AdminStatusSchema),
  };
}
```

- [ ] **Step 5: Run the tests, typecheck and commit**

Run: `bun test apps/agent && bun run typecheck`
Expected: PASS, with no type errors.

```bash
git add apps/agent bun.lock
git commit -F - <<'EOF'
feat(agent): host/admin config and a typed Worker client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 9: Snapshot zips and transfers

**Files:**
- Create: `apps/agent/src/host/snapshot.ts`, `apps/agent/src/host/transfer.ts`
- Test: `apps/agent/test/snapshot.test.ts`, `apps/agent/test/transfer.test.ts`

**Interfaces:**
- Consumes: `UserError` and `Fetch` from `@mc/profile`; `OfflineError` (Task 8); `Zip`, `ZipDeflate`, `Unzip` and `UnzipInflate` from `fflate`.
- Produces:
  - `snapshotPaths(levelName): string[]`
  - `zipSnapshot(serverDir, levelName, outFile): Promise<{sha256: string; size: number}>`
  - `class ChecksumError extends UserError`
  - `extractSnapshot(zipFile, serverDir, levelName, expectedSha256): Promise<void>`
  - `sha256File(path): Promise<string>`
  - `clearSnapshotPaths(serverDir, levelName): Promise<void>`
  - `downloadTo(fetch, url, dest): Promise<void>`
  - `uploadFile(fetch, target: {url, headers}, file): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/snapshot.test.ts`:
```ts
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { ChecksumError, extractSnapshot, sha256File, snapshotPaths, zipSnapshot } from "../src/host/snapshot";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-snap-"));
});

function put(dir: string, rel: string, data: string | Uint8Array) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), data);
}

function listAll(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listAll(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}

function server(dir: string, levelName = "world") {
  const region = crypto.getRandomValues(new Uint8Array(200_000));
  put(dir, `${levelName}/level.dat`, "level");
  put(dir, `${levelName}/region/r.0.0.mca`, region);
  put(dir, `${levelName}/session.lock`, "locked");
  put(dir, "config/chunky/tasks.properties", "radius=2000");
  put(dir, "ops.json", "[]");
  put(dir, "usercache.json", "[]");
  put(dir, "mods/lithium.jar", "jar");
  put(dir, "logs/latest.log", "log");
  put(dir, "server.properties", "motd=x");
  return region;
}

test("snapshot paths follow the level name", () => {
  expect(snapshotPaths("adventure")).toEqual(["adventure", "config", "ops.json", "banned-players.json", "banned-ips.json", "usercache.json"]);
});

test("zip → extract round-trips exactly the snapshot paths, without session.lock", async () => {
  const src = join(root, "src");
  const region = server(src);
  const zip = join(root, "out", "snap.zip");
  const { sha256, size } = await zipSnapshot(src, "world", zip);
  expect(sha256).toBe(await sha256File(zip));
  expect(size).toBe(statSync(zip).size);

  const dest = join(root, "dest");
  await extractSnapshot(zip, dest, "world", sha256);
  expect(listAll(dest)).toEqual([
    "config/chunky/tasks.properties",
    "ops.json",
    "usercache.json",
    "world/level.dat",
    "world/region/r.0.0.mca",
  ]);
  expect(new Uint8Array(readFileSync(join(dest, "world/region/r.0.0.mca")))).toEqual(region);
});

test("a custom level-name is zipped and extracted under its own folder", async () => {
  const src = join(root, "src");
  server(src, "adventure");
  const zip = join(root, "snap.zip");
  const { sha256 } = await zipSnapshot(src, "adventure", zip);
  const dest = join(root, "dest");
  await extractSnapshot(zip, dest, "adventure", sha256);
  expect(existsSync(join(dest, "adventure/level.dat"))).toBe(true);
  expect(existsSync(join(dest, "world"))).toBe(false);
});

test("extract clears stale snapshot paths but leaves the rest of the server alone", async () => {
  const src = join(root, "src");
  server(src);
  const zip = join(root, "snap.zip");
  const { sha256 } = await zipSnapshot(src, "world", zip);
  const dest = join(root, "dest");
  put(dest, "world/region/r.9.9.mca", "stale");
  put(dest, "mods/keep.jar", "jar");
  await extractSnapshot(zip, dest, "world", sha256);
  expect(existsSync(join(dest, "world/region/r.9.9.mca"))).toBe(false);
  expect(existsSync(join(dest, "mods/keep.jar"))).toBe(true);
});

test("a checksum mismatch is rejected before anything is touched", async () => {
  const src = join(root, "src");
  server(src);
  const zip = join(root, "snap.zip");
  await zipSnapshot(src, "world", zip);
  const dest = join(root, "dest");
  put(dest, "world/level.dat", "mine");
  await expect(extractSnapshot(zip, dest, "world", "0".repeat(64))).rejects.toBeInstanceOf(ChecksumError);
  expect(readFileSync(join(dest, "world/level.dat"), "utf8")).toBe("mine");
});

test("entries outside the snapshot paths are refused", async () => {
  for (const name of ["../evil.txt", "mods/evil.jar"]) {
    const zip = join(root, `bad-${name.length}.zip`);
    writeFileSync(zip, zipSync({ [name]: new TextEncoder().encode("x") }));
    await expect(extractSnapshot(zip, join(root, "dest"), "world", await sha256File(zip))).rejects.toThrow("unsafe");
  }
});
```

`apps/agent/test/transfer.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@mc/profile";
import { OfflineError } from "../src/host/api";
import { downloadTo, uploadFile } from "../src/host/transfer";

const dir = () => mkdtempSync(join(tmpdir(), "mc-xfer-"));

test("downloadTo streams the body into the file", async () => {
  const dest = join(dir(), "sub", "a.zip");
  await downloadTo(async () => new Response("zip bytes"), "https://r2.test/a.zip", dest);
  expect(readFileSync(dest, "utf8")).toBe("zip bytes");
});

test("downloadTo turns failures into OfflineError", async () => {
  const down: Fetch = async () => {
    throw new Error("reset");
  };
  expect(await downloadTo(down, "https://r2.test/a", join(dir(), "a")).catch((e) => e)).toBeInstanceOf(OfflineError);
  expect(await downloadTo(async () => new Response("", { status: 403 }), "https://r2.test/a", join(dir(), "a")).catch((e) => e)).toBeInstanceOf(
    OfflineError,
  );
});

test("uploadFile PUTs the file with the signed headers", async () => {
  const file = join(dir(), "up.zip");
  writeFileSync(file, "payload");
  let seen: { method?: string; headers: Headers; body: string } | null = null;
  const fetch: Fetch = async (_url, init) => {
    seen = { method: init?.method, headers: new Headers(init?.headers), body: await new Response(init?.body).text() };
    return new Response(null, { status: 200 });
  };
  await uploadFile(fetch, { url: "https://r2.test/put", headers: { "x-amz-checksum-sha256": "abc=" } }, file);
  expect(seen!.method).toBe("PUT");
  expect(seen!.headers.get("x-amz-checksum-sha256")).toBe("abc=");
  expect(seen!.body).toBe("payload");
  const fail: Fetch = async () => new Response("BadDigest", { status: 400 });
  expect(await uploadFile(fail, { url: "https://r2.test/put", headers: {} }, file).catch((e) => e)).toBeInstanceOf(OfflineError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/agent/test/snapshot.test.ts apps/agent/test/transfer.test.ts`
Expected: FAIL with missing modules.

- [ ] **Step 3: Implement**

`apps/agent/src/host/snapshot.ts`:
```ts
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { UserError } from "@mc/profile";
import { Unzip, UnzipInflate, Zip, ZipDeflate } from "fflate";

/** What a snapshot holds. Everything else is rebuilt from the world's pinned lockfile. */
export function snapshotPaths(levelName: string): string[] {
  return [levelName, "config", "ops.json", "banned-players.json", "banned-ips.json", "usercache.json"];
}

/** Held open by a running server (locked on Windows) and meaningless on another PC. */
const SKIP = new Set(["session.lock"]);

export class ChecksumError extends UserError {}

async function* walk(root: string, rel: string): AsyncGenerator<string> {
  const st = await stat(join(root, rel)).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    yield rel;
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of (await readdir(join(root, rel))).sort()) yield* walk(root, `${rel}/${entry}`);
}

export async function sha256File(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

/** Stream the snapshot paths of serverDir into outFile. Never holds the whole zip in memory. */
export async function zipSnapshot(serverDir: string, levelName: string, outFile: string): Promise<{ sha256: string; size: number }> {
  await mkdir(dirname(outFile), { recursive: true });
  const sink = Bun.file(outFile).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  let failed: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) {
      failed = err;
      return;
    }
    hasher.update(chunk);
    size += chunk.length;
    sink.write(chunk);
  });
  for (const top of snapshotPaths(levelName)) {
    for await (const rel of walk(serverDir, top)) {
      if (SKIP.has(basename(rel))) continue;
      const entry = new ZipDeflate(rel, { level: 6 });
      zip.add(entry);
      for await (const chunk of Bun.file(join(serverDir, rel)).stream()) entry.push(chunk);
      entry.push(new Uint8Array(0), true);
    }
  }
  zip.end();
  await sink.end();
  if (failed) throw failed;
  return { sha256: hasher.digest("hex"), size };
}

export async function clearSnapshotPaths(serverDir: string, levelName: string): Promise<void> {
  for (const p of snapshotPaths(levelName)) await rm(join(serverDir, p), { recursive: true, force: true });
}

/** Directory entries return null; anything outside the snapshot paths is refused. */
function entryPath(name: string, levelName: string): string | null {
  if (name.endsWith("/")) return null;
  const parts = name.split("/");
  const unsafe =
    parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\") || p.includes(":")) ||
    !snapshotPaths(levelName).includes(parts[0]!);
  if (unsafe) throw new UserError(`The world download contains an unsafe path ("${name}"), so it wasn't unpacked. Tell a maintainer.`);
  return name;
}

/** Check the sha256 first; only then replace the snapshot paths in serverDir with the zip's contents. */
export async function extractSnapshot(zipFile: string, serverDir: string, levelName: string, expectedSha256: string): Promise<void> {
  if ((await sha256File(zipFile)) !== expectedSha256) {
    throw new ChecksumError("The downloaded world is damaged (its sha256 doesn't match).");
  }
  await clearSnapshotPaths(serverDir, levelName);
  await mkdir(serverDir, { recursive: true });
  const writes: Promise<unknown>[] = [];
  let failed: unknown = null;
  const unzip = new Unzip((file) => {
    let rel: string | null;
    try {
      rel = entryPath(file.name, levelName);
    } catch (err) {
      failed = err;
      return;
    }
    if (rel === null) return;
    const dest = join(serverDir, rel);
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) {
        failed = err;
        return;
      }
      chunks.push(chunk);
      if (final) writes.push(mkdir(dirname(dest), { recursive: true }).then(() => Bun.write(dest, new Blob(chunks))));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for await (const chunk of Bun.file(zipFile).stream()) {
    unzip.push(chunk);
    if (failed) break;
  }
  if (!failed) unzip.push(new Uint8Array(0), true);
  await Promise.all(writes);
  if (failed) throw failed;
}
```

`apps/agent/src/host/transfer.ts`:
```ts
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Fetch } from "@mc/profile";
import { OfflineError } from "./api";

export async function downloadTo(fetch: Fetch, url: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new OfflineError(`Couldn't download the world (${(err as Error).message}). Check your internet connection and try again.`);
  }
  if (!res.ok || !res.body) throw new OfflineError(`Couldn't download the world (HTTP ${res.status}). Try again in a few minutes.`);
  await mkdir(dirname(dest), { recursive: true });
  const sink = Bun.file(dest).writer();
  for await (const chunk of res.body) sink.write(chunk);
  await sink.end();
}

export async function uploadFile(fetch: Fetch, target: { url: string; headers: Record<string, string> }, file: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(target.url, { method: "PUT", headers: target.headers, body: Bun.file(file) });
  } catch (err) {
    throw new OfflineError(`Couldn't upload the world (${(err as Error).message}).`);
  }
  if (!res.ok) throw new OfflineError(`Couldn't upload the world (HTTP ${res.status}).`);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/agent/test/snapshot.test.ts apps/agent/test/transfer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`

```bash
git add apps/agent
git commit -F - <<'EOF'
feat(agent): streaming snapshot zip/unzip and R2 transfers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 10: Local state, tailnet address and the Java check

**Files:**
- Create: `apps/agent/src/host/state.ts`, `apps/agent/src/host/address.ts`
- Modify: `apps/agent/src/run/java.ts` (add `requireJava`), `apps/agent/src/commands.ts` (`cmdRun` uses it)
- Test: `apps/agent/test/state.test.ts`, `apps/agent/test/address.test.ts`, `apps/agent/test/run.test.ts` (extend)

**Interfaces:**
- Consumes: `UserError`; `javaMajor`.
- Produces:
  - `interface LocalState { worldId: string; baseRev: number; dirty: boolean }`
  - `readState(dataDir): Promise<LocalState | null>` and `writeState(dataDir, state): Promise<void>`
  - `serverDirFor(dataDir, worldId): string`
  - `tmpDirFor(dataDir): string`
  - `stamp(ms): string`
  - `moveToRecovered(dataDir, worldId, now): Promise<string | null>`
  - `lastSaveTime(serverDir, levelName): Promise<number | null>`
  - `isTailnetIPv4(ip): boolean`
  - `tailnetAddress(ifaces?): string`
  - `requireJava(marker: {minecraft, javaMajor}, javaBin?): void`

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/state.test.ts`:
```ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastSaveTime, moveToRecovered, readState, serverDirFor, stamp, writeState } from "../src/host/state";

const dir = () => mkdtempSync(join(tmpdir(), "mc-state-"));

test("state round-trips and is null when missing", async () => {
  const d = dir();
  expect(await readState(d)).toBeNull();
  await writeState(d, { worldId: "w1", baseRev: 3, dirty: true });
  expect(await readState(d)).toEqual({ worldId: "w1", baseRev: 3, dirty: true });
});

test("a damaged state file is reported", async () => {
  const d = dir();
  writeFileSync(join(d, "state.json"), "{");
  await expect(readState(d)).rejects.toThrow("is damaged");
});

test("stamp is a sortable local timestamp", () => {
  expect(stamp(new Date(2026, 8, 26, 20, 4, 5).getTime())).toBe("2026-09-26_20-04-05");
});

test("moveToRecovered moves the world's server folder aside", async () => {
  const d = dir();
  const server = serverDirFor(d, "w1");
  mkdirSync(join(server, "world"), { recursive: true });
  writeFileSync(join(server, "world", "level.dat"), "x");
  const dest = await moveToRecovered(d, "w1", new Date(2026, 8, 26, 20, 4, 5).getTime());
  expect(dest).toBe(join(d, "recovered", "2026-09-26_20-04-05-w1"));
  expect(readFileSync(join(dest!, "world", "level.dat"), "utf8")).toBe("x");
  expect(existsSync(server)).toBe(false);
  expect(await moveToRecovered(d, "w1", 0)).toBeNull();
});

test("lastSaveTime reads level.dat under the level name", async () => {
  const d = dir();
  mkdirSync(join(d, "adventure"));
  writeFileSync(join(d, "adventure", "level.dat"), "x");
  const t = new Date(2026, 8, 26, 14, 32);
  utimesSync(join(d, "adventure", "level.dat"), t, t);
  expect(await lastSaveTime(d, "adventure")).toBe(t.getTime());
  expect(await lastSaveTime(d, "world")).toBeNull();
});
```

`apps/agent/test/address.test.ts`:
```ts
import { expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { isTailnetIPv4, tailnetAddress } from "../src/host/address";

const v4 = (address: string) => ({ address, family: "IPv4", internal: false }) as NetworkInterfaceInfo;

test("recognises the tailnet range 100.64.0.0/10", () => {
  expect(isTailnetIPv4("100.64.0.1")).toBe(true);
  expect(isTailnetIPv4("100.127.255.254")).toBe(true);
  expect(isTailnetIPv4("100.128.0.1")).toBe(false);
  expect(isTailnetIPv4("192.168.1.2")).toBe(false);
});

test("prefers a tailscale-named interface", () => {
  expect(tailnetAddress({ eth0: [v4("100.70.0.9")], tailscale0: [v4("100.101.2.3")] })).toBe("100.101.2.3");
  expect(tailnetAddress({ Tailscale: [v4("100.90.0.1")] })).toBe("100.90.0.1");
});

test("falls back to any tailnet IPv4 and explains when there is none", () => {
  expect(tailnetAddress({ eth0: [v4("192.168.1.2"), v4("100.70.0.9")] })).toBe("100.70.0.9");
  expect(() => tailnetAddress({ eth0: [v4("192.168.1.2")] })).toThrow("isn't connected to the Minecraft tailnet");
});
```

Append to `apps/agent/test/run.test.ts`. Add `requireJava` to its existing `../src/run/java` import. Also add `chmodSync` to the `node:fs` import and `mkdtempSync`, `tmpdir` and `join` if they aren't already imported.
```ts
test("requireJava explains a missing or too-old Java", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-java-"));
  const fake = join(dir, "java");
  writeFileSync(fake, '#!/bin/sh\necho \'openjdk version "21.0.2"\' >&2\n');
  chmodSync(fake, 0o755);
  expect(() => requireJava({ minecraft: "26.3", javaMajor: 25 }, fake)).toThrow(
    "Minecraft 26.3 needs Java 25, but this PC has Java 21. Install Java 25 and try again.",
  );
  expect(() => requireJava({ minecraft: "26.3", javaMajor: 21 }, fake)).not.toThrow();
  expect(() => requireJava({ minecraft: "26.3", javaMajor: 25 }, join(dir, "nope"))).toThrow("Java isn't installed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/agent/test/state.test.ts apps/agent/test/address.test.ts apps/agent/test/run.test.ts`
Expected: FAIL with missing modules, and `requireJava` not exported.

- [ ] **Step 3: Implement**

`apps/agent/src/host/state.ts`:
```ts
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserError } from "@mc/profile";

/** `dirty`: this PC's copy of the world may be newer than the cloud's (the server ran since the last committed stop). */
export interface LocalState {
  worldId: string;
  baseRev: number;
  dirty: boolean;
}

export const serverDirFor = (dataDir: string, worldId: string) => join(dataDir, worldId, "server");
export const tmpDirFor = (dataDir: string) => join(dataDir, "tmp");

export async function readState(dataDir: string): Promise<LocalState | null> {
  const path = join(dataDir, "state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as LocalState;
  } catch {
    throw new UserError(`${path} is damaged. Move it somewhere else, then run mc-host start again.`);
  }
}

/** Write via a temp file and rename, so a crash mid-write never leaves half a file. */
export async function writeState(dataDir: string, state: LocalState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "state.json");
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

export function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Move the world's server folder to recovered/<stamp>-<worldId>. Returns null if there was nothing to move. */
export async function moveToRecovered(dataDir: string, worldId: string, now: number): Promise<string | null> {
  const src = serverDirFor(dataDir, worldId);
  if (!existsSync(src)) return null;
  const dest = join(dataDir, "recovered", `${stamp(now)}-${worldId}`);
  await mkdir(dirname(dest), { recursive: true });
  await rename(src, dest);
  return dest;
}

export async function lastSaveTime(serverDir: string, levelName: string): Promise<number | null> {
  const st = await stat(join(serverDir, levelName, "level.dat")).catch(() => null);
  return st ? st.mtimeMs : null;
}
```

`apps/agent/src/host/address.ts`:
```ts
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { UserError } from "@mc/profile";

export function isTailnetIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/**
 * This PC's address on the Minecraft tailnet. In Docker the agent shares the Tailscale sidecar's
 * network namespace, so tailscale0 is visible here; on Windows the Tailscale adapter is too.
 */
export function tailnetAddress(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string {
  const found = Object.entries(ifaces).flatMap(([name, list]) =>
    (list ?? [])
      .filter((a) => (a.family === "IPv4" || (a.family as unknown) === 4) && isTailnetIPv4(a.address))
      .map((a) => ({ name, ip: a.address })),
  );
  const tailscaleFirst = (n: string) => (/tailscale/i.test(n) ? 0 : 1);
  found.sort((x, y) => tailscaleFirst(x.name) - tailscaleFirst(y.name));
  if (!found[0]) {
    throw new UserError("This PC isn't connected to the Minecraft tailnet. Open Tailscale, make sure it's connected, and try again.");
  }
  return found[0].ip;
}
```

Append to `apps/agent/src/run/java.ts`. Add `import { UserError } from "@mc/profile";` at the top.
```ts
/** Throw a UserError unless a new enough Java is available. */
export function requireJava(marker: { minecraft: string; javaMajor: number }, javaBin?: string): void {
  const java = javaMajor(javaBin);
  if (java === null) {
    throw new UserError(`Java isn't installed or isn't on your PATH. Minecraft ${marker.minecraft} needs Java ${marker.javaMajor}.`);
  }
  if (java < marker.javaMajor) {
    throw new UserError(
      `Minecraft ${marker.minecraft} needs Java ${marker.javaMajor}, but this PC has Java ${java}. Install Java ${marker.javaMajor} and try again.`,
    );
  }
}
```

In `apps/agent/src/commands.ts`, in `cmdRun`, replace the block from `const java = javaMajor(deps.javaBin);` through the second `throw new UserError(... Install Java ...)` with:
```ts
  requireJava(marker, deps.javaBin);
```
and change the import `import { javaMajor } from "./run/java";` to `import { requireJava } from "./run/java";`.

- [ ] **Step 4: Run all the agent tests**

Run: `bun test apps/agent`
Expected: PASS. That includes the existing `commands.test.ts` Java-message tests, which now go through `requireJava`.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`

```bash
git add apps/agent
git commit -F - <<'EOF'
feat(agent): local host state, tailnet address and a shared Java check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 11: Server console and terminal input

**Files:**
- Create: `apps/agent/src/host/console.ts`, `apps/agent/src/host/terminal.ts`, `apps/agent/test/fixtures/echo-server.ts`, `apps/agent/test/host-fakes.ts`
- Test: `apps/agent/test/console.test.ts`

**Interfaces:**
- Consumes: `LAUNCHER_JAR` and `ServerMarker` from `../server/build`.
- Produces:
  - `interface ServerProcess { write(line: string): void; onLine(cb: (line: string) => void): void; exited: Promise<number> }`
  - `class LineSplitter { push(text): string[] }`
  - `class ServerConsole(server)` with `send(command)`, `onLine(cb)` and `waitFor(pattern, timeoutMs): Promise<string>`. `waitFor` rejects when the server exits.
  - `javaCommand(marker, javaBin?): string[]`
  - `spawnProcess(cmd: string[], cwd, echo: (text) => void): ServerProcess`
  - `class TerminalInput(source)` with `ask(question, out): Promise<string>` and `forwardTo(cb | null)`
  - `test/host-fakes.ts`: `class FakeServer implements ServerProcess` (`written`, `emit(line)`, `exit(code)`) and `defaultRespond`

- [ ] **Step 1: Write the fixtures and failing tests**

`apps/agent/test/fixtures/echo-server.ts`:
```ts
// Stand-in for a Minecraft server: announces Done, echoes each command, exits on "stop".
console.log('[Server thread/INFO]: Done (1.234s)! For help, type "help"');
for await (const line of console) {
  console.log(`got ${line}`);
  if (line === "stop") process.exit(0);
}
```

`apps/agent/test/host-fakes.ts` (Task 12 extends this file):
```ts
import type { ServerProcess } from "../src/host/console";

/** Answer the commands a real server answers, asynchronously like a real process. */
export function defaultRespond(line: string, s: FakeServer): void {
  if (line === "save-all flush") queueMicrotask(() => s.emit("[Server thread/INFO]: Saved the game"));
  if (line === "stop") queueMicrotask(() => s.exit(0));
}

export class FakeServer implements ServerProcess {
  written: string[] = [];
  private listeners: ((line: string) => void)[] = [];
  private resolveExit!: (code: number) => void;
  exited = new Promise<number>((resolve) => (this.resolveExit = resolve));

  constructor(
    private respond: (line: string, s: FakeServer) => void = defaultRespond,
    private events?: string[],
  ) {}

  write(line: string): void {
    this.written.push(line);
    this.events?.push(`server:${line}`);
    this.respond(line, this);
  }

  onLine(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }

  emit(line: string): void {
    for (const cb of this.listeners) cb(line);
  }

  exit(code: number): void {
    this.resolveExit(code);
  }
}
```

`apps/agent/test/console.test.ts`:
```ts
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { javaCommand, LineSplitter, ServerConsole, spawnProcess } from "../src/host/console";
import { TerminalInput } from "../src/host/terminal";
import { FakeServer } from "./host-fakes";

test("LineSplitter joins partial chunks and handles CRLF", () => {
  const s = new LineSplitter();
  expect(s.push("[a] Do")).toEqual([]);
  expect(s.push("ne (1s)\r\n[b] x\n[c")).toEqual(["[a] Done (1s)", "[b] x"]);
  expect(s.push("]\n")).toEqual(["[c]"]);
});

test("waitFor resolves on the next matching line", async () => {
  const server = new FakeServer(() => {});
  const con = new ServerConsole(server);
  const saved = con.waitFor(/Saved the game/, 1_000);
  server.emit("[Server thread/INFO]: Saving the game");
  server.emit("[Server thread/INFO]: Saved the game");
  expect(await saved).toContain("Saved the game");
});

test("waitFor times out, and rejects when the server exits", async () => {
  const server = new FakeServer(() => {});
  const con = new ServerConsole(server);
  await expect(con.waitFor(/never/, 10)).rejects.toThrow("Timed out");
  const pending = con.waitFor(/never/, 60_000);
  server.exit(0);
  await expect(pending).rejects.toThrow("server stopped");
});

test("typed lines and injected commands reach the server as whole lines, in order", () => {
  const server = new FakeServer(() => {});
  const con = new ServerConsole(server);
  const source = new EventEmitter();
  const input = new TerminalInput(source);
  input.forwardTo((line) => con.send(line));
  source.emit("line", "say hello");
  con.send("save-off");
  source.emit("line", "list");
  expect(server.written).toEqual(["say hello", "save-off", "list"]);
});

test("ask takes the next line instead of forwarding it; EOF answers empty", async () => {
  const source = new EventEmitter();
  const input = new TerminalInput(source);
  const forwarded: string[] = [];
  input.forwardTo((l) => forwarded.push(l));
  const out: string[] = [];
  const answer = input.ask("Upload it now? [Y/n] ", (s) => out.push(s));
  source.emit("line", "n");
  expect(await answer).toBe("n");
  expect(forwarded).toEqual([]);
  expect(out).toEqual(["Upload it now? [Y/n] "]);
  const second = input.ask("again? ", () => {});
  source.emit("close");
  expect(await second).toBe("");
});

test("javaCommand uses the marker's memory and the Fabric launcher", () => {
  expect(javaCommand({ profile: "p", minecraft: "26.3", javaMajor: 25, memory: { min: "2G", max: "4G" }, complete: true })).toEqual([
    "java",
    "-Xms2G",
    "-Xmx4G",
    "-jar",
    "fabric-server-launch.jar",
    "nogui",
  ]);
});

test("spawnProcess pipes commands in and lines out", async () => {
  const echoed: string[] = [];
  const proc = spawnProcess([process.execPath, join(import.meta.dir, "fixtures", "echo-server.ts")], import.meta.dir, (t) => echoed.push(t));
  const con = new ServerConsole(proc);
  await con.waitFor(/Done \(/, 10_000);
  const got = con.waitFor(/^got list$/, 10_000);
  con.send("list");
  await got;
  con.send("stop");
  expect(await proc.exited).toBe(0);
  expect(echoed.join("")).toContain("got list");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/agent/test/console.test.ts`
Expected: FAIL with missing modules.

- [ ] **Step 3: Implement**

`apps/agent/src/host/console.ts`:
```ts
import { LAUNCHER_JAR, type ServerMarker } from "../server/build";

export interface ServerProcess {
  /** Send one command line to the server's stdin. */
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  exited: Promise<number>;
}

export class LineSplitter {
  private buf = "";

  push(text: string): string[] {
    this.buf += text;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop()!;
    return parts;
  }
}

interface Waiter {
  pattern: RegExp;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The agent's view of the running server. Every write is one whole line, so commands you type
 * and commands the agent injects (save-off, chunky …) can never interleave inside a line.
 */
export class ServerConsole {
  private waiters: Waiter[] = [];
  private listeners: ((line: string) => void)[] = [];

  constructor(private server: ServerProcess) {
    server.onLine((line) => this.seen(line));
    void server.exited.then(() => this.close());
  }

  send(command: string): void {
    this.server.write(command);
  }

  onLine(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }

  waitFor(pattern: RegExp, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        pattern,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.drop(w);
          reject(new Error(`Timed out waiting for ${pattern}`));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  private drop(w: Waiter) {
    this.waiters = this.waiters.filter((x) => x !== w);
  }

  private seen(line: string) {
    for (const cb of this.listeners) cb(line);
    for (const w of [...this.waiters]) {
      if (w.pattern.test(line)) {
        clearTimeout(w.timer);
        this.drop(w);
        w.resolve(line);
      }
    }
  }

  private close() {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("The server stopped."));
    }
    this.waiters = [];
  }
}

export function javaCommand(marker: ServerMarker, javaBin = "java"): string[] {
  return [javaBin, `-Xms${marker.memory.min}`, `-Xmx${marker.memory.max}`, "-jar", LAUNCHER_JAR, "nogui"];
}

/** Start the server with piped stdin/stdout; `echo` receives the raw output for the terminal. */
export function spawnProcess(cmd: string[], cwd: string, echo: (text: string) => void): ServerProcess {
  const proc = Bun.spawn(cmd, { cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const listeners: ((line: string) => void)[] = [];
  const split = new LineSplitter();
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      echo(text);
      for (const line of split.push(text)) for (const cb of listeners) cb(line);
    }
  })();
  return {
    write(line) {
      try {
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
      } catch {
        // The server already exited; the session notices through `exited`.
      }
    },
    onLine(cb) {
      listeners.push(cb);
    },
    exited: proc.exited,
  };
}
```

The `waitFor`-on-exit test expects "server stopped". The rejection message is "The server stopped.", and `toThrow` matches substrings case-sensitively, so this passes.

`apps/agent/src/host/terminal.ts`:
```ts
interface LineSource {
  on(event: "line", cb: (line: string) => void): unknown;
  on(event: "close", cb: () => void): unknown;
}

/**
 * The one reader of the terminal. While a question is pending the next line answers it;
 * otherwise lines go to the server console (when forwarding is on).
 */
export class TerminalInput {
  private pending: ((line: string) => void) | null = null;
  private forward: ((line: string) => void) | null = null;
  private closed = false;

  constructor(source: LineSource) {
    source.on("line", (line) => {
      if (this.pending) {
        const answer = this.pending;
        this.pending = null;
        answer(line);
      } else {
        this.forward?.(line);
      }
    });
    source.on("close", () => {
      this.closed = true;
      this.pending?.("");
      this.pending = null;
    });
  }

  /** With no terminal attached (EOF), questions get "" so defaults apply instead of hanging. */
  ask(question: string, out: (text: string) => void): Promise<string> {
    out(question);
    if (this.closed) return Promise.resolve("");
    return new Promise((resolve) => (this.pending = resolve));
  }

  forwardTo(cb: ((line: string) => void) | null): void {
    this.forward = cb;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/agent/test/console.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`

```bash
git add apps/agent
git commit -F - <<'EOF'
feat(agent): server console multiplexer and terminal input

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---
### Task 12: Session dependencies, sync helpers and `prepare` (recovery, claim, download, build)

**Files:**
- Create: `apps/agent/src/host/deps.ts`, `apps/agent/src/host/sync.ts`, `apps/agent/src/host/prepare.ts`
- Modify: `apps/agent/test/host-fakes.ts` (add FakeApi, ManualTimers, StopSignal, makeHarness and fixtures)
- Test: `apps/agent/test/prepare.test.ts`

**Interfaces:**
- Consumes:
  - `AgentApi`, `hhmm`, `LeaseLostError`, `StaleRevError`, `LeaseHeldError` and `OfflineError` (Task 8)
  - `zipSnapshot`, `extractSnapshot` and `ChecksumError` (Task 9)
  - `readState`, `writeState`, `serverDirFor`, `tmpDirFor`, `moveToRecovered` and `lastSaveTime` (Task 10)
  - `ServerProcess` (Task 11)
  - `parseProfile`, `parseLock`, `Profile` and `Lockfile` from `@mc/profile`
  - `ServerMarker`
- Produces:
  - constants `HEARTBEAT_MS`, `AUTOSAVE_MS`, `SAVE_TIMEOUT_MS`, `UPLOAD_ATTEMPTS`, `DOWNLOAD_ATTEMPTS` and `PREGEN_RADIUS`
  - `interface Timers { every(ms, fn): () => void }`
  - `interface SessionDeps` (fields below)
  - `yes(answer, byDefault): boolean`
  - `mb(bytes): string`
  - `class UploadFailedError extends UserError`
  - `pushZip(deps, {sessionId, baseRev, pregenDone}, file, {sha256, size}): Promise<number>`
  - `uploadSnapshot(deps, {sessionId, baseRev, serverDir, levelName, pregenDone}): Promise<number>`
  - `fetchSnapshot(deps, latest: SnapshotRef, serverDir, levelName): Promise<void>`
  - `interface Prepared { world, sessionId, baseRev, serverDir, levelName, marker, pregenDone, address, unhook }`
  - `prepare(deps): Promise<Prepared>`

`SessionDeps` is the only seam between the session logic and the real world:
```ts
export interface SessionDeps {
  api: AgentApi;
  dataDir: string;
  log: (line: string) => void;
  ask: (question: string) => Promise<string>;
  address: () => string;
  build: (o: { profile: Profile; lock: Lockfile; dir: string }) => Promise<ServerMarker>;
  ensureEula: (serverDir: string) => Promise<boolean>;
  checkJava: (marker: ServerMarker) => void;
  launch: (dir: string, marker: ServerMarker) => ServerProcess;
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
```

- [ ] **Step 1: Extend the test fakes**

Append to `apps/agent/test/host-fakes.ts`. Merge the new imports at the top of the file:
```ts
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { profileHash, type Lockfile, type Profile } from "@mc/profile";
import type { ClaimResponse, CommitRequest, LeaseInfo, Manifest, UploadTarget, UploadUrlRequest } from "@mc/protocol";
import { makeProfile } from "../../../packages/profile/test/fakes";
import { OfflineError, type AgentApi } from "../src/host/api";
import type { SessionDeps, Timers } from "../src/host/deps";
import { zipSnapshot } from "../src/host/snapshot";
import type { ServerMarker } from "../src/server/build";

export const SESSION = "session-0123456789";
export const MARKER: ServerMarker = { profile: "test", minecraft: "26.3", javaMajor: 25, memory: { min: "2G", max: "4G" }, complete: true };
export const DONE_LINE = '[Server thread/INFO]: Done (1.234s)! For help, type "help"';
export const CHUNKY_DONE_LINE = "[Server thread/INFO]: [Chunky] Task finished for minecraft:overworld. Processed: 100 chunks (100.00%)";

export async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (cond()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for a condition");
}

export async function worldFiles(over: Record<string, unknown> = {}): Promise<{ profile: Profile; lockfile: Lockfile }> {
  const profile = makeProfile(over);
  const lockfile: Lockfile = {
    lockfileVersion: 1,
    profile: profile.name,
    profileHash: await profileHash(profile),
    minecraft: profile.minecraft,
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files: [],
  };
  return { profile, lockfile };
}

export async function manifestFor(
  o: {
    worldId?: string;
    latest?: { rev: number; sha256: string; size: number } | null;
    pregenDone?: boolean;
    lease?: (LeaseInfo & { you: boolean }) | null;
    profile?: Record<string, unknown>;
  } = {},
): Promise<Manifest> {
  const { profile, lockfile } = await worldFiles(o.profile);
  return {
    world: { id: o.worldId ?? "w1", name: "test", minecraft: "26.3" },
    profile,
    lockfile,
    pregenDone: o.pregenDone ?? false,
    latest: o.latest ? { ...o.latest, url: `https://r2.test/rev${o.latest.rev}.zip` } : null,
    lease: o.lease ?? null,
  };
}

/** A zipped server folder: what a download delivers. */
export async function fixtureSnapshot(levelName = "world", content = "from the cloud") {
  const root = mkdtempSync(join(tmpdir(), "mc-fixture-"));
  mkdirSync(join(root, "src", levelName), { recursive: true });
  writeFileSync(join(root, "src", levelName, "level.dat"), content);
  const zip = join(root, "fixture.zip");
  return { zip, ...(await zipSnapshot(join(root, "src"), levelName, zip)) };
}

export class FakeApi implements AgentApi {
  latestRev: number;
  claimError: Error | null = null;
  heartbeatError: Error | null = null;
  uploadFailures = 0;
  commits: CommitRequest[] = [];

  constructor(
    public manifestValue: Manifest,
    private events: string[],
  ) {
    this.latestRev = manifestValue.latest?.rev ?? 0;
  }

  async manifest(): Promise<Manifest> {
    this.events.push("api:manifest");
    return this.manifestValue;
  }
  async claim(hostAddress: string): Promise<ClaimResponse> {
    this.events.push(`api:claim ${hostAddress}`);
    if (this.claimError) throw this.claimError;
    return { sessionId: SESSION, baseRev: this.latestRev, expiresAt: 0 };
  }
  async heartbeat(): Promise<void> {
    this.events.push("api:heartbeat");
    if (this.heartbeatError) throw this.heartbeatError;
  }
  async release(): Promise<void> {
    this.events.push("api:release");
  }
  async uploadUrl(req: UploadUrlRequest): Promise<UploadTarget> {
    this.events.push(`api:uploadUrl ${req.baseRev}`);
    if (this.uploadFailures > 0) {
      this.uploadFailures--;
      throw new OfflineError("Couldn't upload the world (offline).");
    }
    return { rev: req.baseRev + 1, key: `k${req.baseRev + 1}`, url: "https://r2.test/put", headers: {} };
  }
  async commit(req: CommitRequest): Promise<number> {
    this.events.push(`api:commit ${req.rev}${req.pregenDone ? " pregen" : ""}`);
    this.commits.push(req);
    this.latestRev = req.rev;
    return req.rev;
  }
}

export class ManualTimers implements Timers {
  private fns = new Map<number, Set<() => void>>();
  every(ms: number, fn: () => void): () => void {
    const set = this.fns.get(ms) ?? new Set();
    set.add(fn);
    this.fns.set(ms, set);
    return () => set.delete(fn);
  }
  fire(ms: number): void {
    for (const fn of [...(this.fns.get(ms) ?? [])]) fn();
  }
}

export class StopSignal {
  private handlers = new Set<() => void>();
  on = (handler: () => void) => {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  };
  fire(): void {
    for (const h of [...this.handlers]) h();
  }
  get count(): number {
    return this.handlers.size;
  }
}

export interface Harness {
  deps: SessionDeps;
  api: FakeApi;
  events: string[];
  logs: string[];
  answers: string[];
  timers: ManualTimers;
  stop: StopSignal;
  servers: FakeServer[];
  forwarded: { cb: ((line: string) => void) | null };
  exits: number[];
  builds: { profile: Profile; dir: string }[];
}

export function makeHarness(
  manifest: Manifest,
  o: { fixtureZip?: string; respond?: (line: string, s: FakeServer) => void } = {},
): Harness {
  const events: string[] = [];
  const h: Omit<Harness, "deps"> = {
    api: new FakeApi(manifest, events),
    events,
    logs: [],
    answers: [],
    timers: new ManualTimers(),
    stop: new StopSignal(),
    servers: [],
    forwarded: { cb: null },
    exits: [],
    builds: [],
  };
  const deps: SessionDeps = {
    api: h.api,
    dataDir: mkdtempSync(join(tmpdir(), "mc-session-")),
    log: (line) => h.logs.push(line),
    ask: async (q) => {
      events.push(`ask:${q}`);
      return h.answers.shift() ?? "";
    },
    address: () => "100.64.0.3",
    build: async (b) => {
      events.push("build");
      h.builds.push(b);
      mkdirSync(b.dir, { recursive: true });
      return MARKER;
    },
    ensureEula: async () => true,
    checkJava: () => {},
    launch: () => {
      const s = new FakeServer(o.respond, events);
      h.servers.push(s);
      return s;
    },
    forwardInput: (cb) => {
      h.forwarded.cb = cb;
    },
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
    now: () => new Date(2026, 8, 26, 21, 0).getTime(),
    sleep: async () => {},
    timers: h.timers,
    exit: (code) => {
      h.exits.push(code);
    },
  };
  return { ...h, deps };
}
```

- [ ] **Step 2: Write the failing test**

`apps/agent/test/prepare.test.ts`:
```ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { LeaseHeldError } from "../src/host/api";
import { prepare } from "../src/host/prepare";
import { readState, serverDirFor, writeState } from "../src/host/state";
import { fixtureSnapshot, makeHarness, manifestFor, MARKER, type Harness } from "./host-fakes";

/** Leave this PC as if its last session never finished uploading. */
async function dirtyPc(h: Harness, baseRev: number, o: { worldId?: string; levelName?: string } = {}) {
  const worldId = o.worldId ?? "w1";
  const levelName = o.levelName ?? "world";
  const dir = serverDirFor(h.deps.dataDir, worldId);
  mkdirSync(join(dir, levelName), { recursive: true });
  writeFileSync(join(dir, levelName, "level.dat"), "local progress");
  const t = new Date(2026, 8, 26, 14, 32);
  utimesSync(join(dir, levelName, "level.dat"), t, t);
  await writeState(h.deps.dataDir, { worldId, baseRev, dirty: true });
}
const recovered = (h: Harness) => (existsSync(join(h.deps.dataDir, "recovered")) ? readdirSync(join(h.deps.dataDir, "recovered")) : []);
const asked = (h: Harness) => h.events.filter((e) => e.startsWith("ask:"));

test("a fresh world: claim, build without datapacks, no download", async () => {
  const h = makeHarness(await manifestFor({ profile: { datapacks: ["vt:afk-display"] } }));
  const p = await prepare(h.deps);
  expect(p).toMatchObject({ baseRev: 0, sessionId: "session-0123456789", levelName: "world", address: "100.64.0.3", marker: MARKER });
  expect(h.events).toEqual(["api:manifest", "api:claim 100.64.0.3", "build"]);
  expect(h.builds[0]!.profile.datapacks).toEqual([]);
  expect(h.logs.join("\n")).toContain("datapacks and the resource pack aren't supported yet");
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 0, dirty: false });
  expect(h.stop.count).toBe(1);
  p.unhook();
  expect(h.stop.count).toBe(0);
});

test("downloads and unpacks the latest rev when this PC is behind", async () => {
  const fx = await fixtureSnapshot();
  const h = makeHarness(await manifestFor({ latest: { rev: 3, sha256: fx.sha256, size: fx.size } }), { fixtureZip: fx.zip });
  const p = await prepare(h.deps);
  expect(p.baseRev).toBe(3);
  expect(h.events).toContain("download https://r2.test/rev3.zip");
  expect(readFileSync(join(p.serverDir, "world", "level.dat"), "utf8")).toBe("from the cloud");
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 3, dirty: false });
});

test("skips the download when this PC already has that rev", async () => {
  const h = makeHarness(await manifestFor({ latest: { rev: 3, sha256: "a".repeat(64), size: 5 } }));
  mkdirSync(join(serverDirFor(h.deps.dataDir, "w1"), "world"), { recursive: true });
  await writeState(h.deps.dataDir, { worldId: "w1", baseRev: 3, dirty: false });
  await prepare(h.deps);
  expect(h.events.some((e) => e.startsWith("download"))).toBe(false);
});

test("retries a damaged download three times, then gives up and releases", async () => {
  const fx = await fixtureSnapshot();
  const h = makeHarness(await manifestFor({ latest: { rev: 2, sha256: "0".repeat(64), size: fx.size } }), { fixtureZip: fx.zip });
  await expect(prepare(h.deps)).rejects.toThrow("Couldn't download the world. Try again later.");
  expect(h.events.filter((e) => e.startsWith("download"))).toHaveLength(3);
  expect(h.logs.filter((l) => l === "The downloaded world is damaged. Trying again…")).toHaveLength(2);
  expect(h.events).toContain("api:release");
});

test("recovery: nobody hosted since, so it asks, then uploads as the next rev", async () => {
  const h = makeHarness(await manifestFor({ latest: { rev: 2, sha256: "a".repeat(64), size: 5 } }));
  await dirtyPc(h, 2);
  h.answers.push("");
  const p = await prepare(h.deps);
  expect(asked(h)).toEqual(["ask:Your last session didn't finish uploading (last save 14:32). Upload it now? [Y/n] "]);
  expect(p.baseRev).toBe(3);
  expect(h.events).toContain("api:commit 3");
  expect(h.events.some((e) => e.startsWith("download"))).toBe(false);
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 3, dirty: false });
});

test("recovery: answering no sets the copy aside and downloads instead", async () => {
  const fx = await fixtureSnapshot();
  const h = makeHarness(await manifestFor({ latest: { rev: 2, sha256: fx.sha256, size: fx.size } }), { fixtureZip: fx.zip });
  await dirtyPc(h, 2);
  h.answers.push("n");
  const p = await prepare(h.deps);
  expect(recovered(h)).toHaveLength(1);
  expect(readFileSync(join(h.deps.dataDir, "recovered", recovered(h)[0]!, "world", "level.dat"), "utf8")).toBe("local progress");
  expect(readFileSync(join(p.serverDir, "world", "level.dat"), "utf8")).toBe("from the cloud");
});

test("recovery: someone hosted since, so the copy is set aside without asking", async () => {
  const fx = await fixtureSnapshot();
  const h = makeHarness(await manifestFor({ latest: { rev: 4, sha256: fx.sha256, size: fx.size } }), { fixtureZip: fx.zip });
  await dirtyPc(h, 2);
  await prepare(h.deps);
  expect(asked(h)).toEqual([]);
  expect(recovered(h)).toHaveLength(1);
  expect(h.logs.join("\n")).toContain("someone has hosted since");
});

test("recovery: someone else is hosting, so the copy is set aside and the claim is refused", async () => {
  const holder = { name: "Sam", hostAddress: "100.64.0.9", claimedAt: 0, expiresAt: 0 };
  const h = makeHarness(await manifestFor({ latest: { rev: 2, sha256: "a".repeat(64), size: 5 }, lease: { ...holder, you: false } }));
  await dirtyPc(h, 2);
  h.api.claimError = new LeaseHeldError("Sam is already hosting at 100.64.0.9 (since 01:00).", holder);
  await expect(prepare(h.deps)).rejects.toBeInstanceOf(LeaseHeldError);
  expect(asked(h)).toEqual([]);
  expect(recovered(h)).toHaveLength(1);
});

test("recovery: a world that's no longer active is set aside", async () => {
  const h = makeHarness(await manifestFor());
  await dirtyPc(h, 5, { worldId: "old" });
  await prepare(h.deps);
  expect(recovered(h)[0]).toEndWith("-old");
});

test("recovery reads the last save time from a custom level-name folder", async () => {
  const h = makeHarness(await manifestFor({ latest: { rev: 1, sha256: "a".repeat(64), size: 5 }, profile: { properties: { "level-name": "adventure" } } }));
  await dirtyPc(h, 1, { levelName: "adventure" });
  h.answers.push("y");
  const p = await prepare(h.deps);
  expect(asked(h)[0]).toContain("(last save 14:32)");
  expect(p.levelName).toBe("adventure");
});

test("a failure after the claim releases the lease", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.build = async () => {
    throw new UserError("Couldn't download lithium.jar");
  };
  await expect(prepare(h.deps)).rejects.toThrow("lithium.jar");
  expect(h.events).toContain("api:release");
  expect(h.stop.count).toBe(0);
});

test("Ctrl+C while preparing releases the lease and exits with 130", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.build = async () => {
    h.stop.fire();
    await Bun.sleep(5);
    return MARKER;
  };
  await prepare(h.deps);
  expect(h.events).toContain("api:release");
  expect(h.exits).toEqual([130]);
});

test("declining the EULA stops before claiming", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.ensureEula = async () => false;
  await expect(prepare(h.deps)).rejects.toThrow("agree to the EULA");
  expect(h.events.some((e) => e.startsWith("api:claim"))).toBe(false);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test apps/agent/test/prepare.test.ts`
Expected: FAIL. The error is "Cannot find module '../src/host/prepare'".

- [ ] **Step 4: Implement deps, sync and prepare**

`apps/agent/src/host/deps.ts`:
```ts
import type { Lockfile, Profile } from "@mc/profile";
import type { ServerMarker } from "../server/build";
import type { AgentApi } from "./api";
import type { ServerProcess } from "./console";

export const HEARTBEAT_MS = 2 * 60_000;
export const AUTOSAVE_MS = 30 * 60_000;
export const SAVE_TIMEOUT_MS = 2 * 60_000;
export const UPLOAD_ATTEMPTS = 3;
export const DOWNLOAD_ATTEMPTS = 3;
export const PREGEN_RADIUS = 2000;

export interface Timers {
  /** Call fn every ms milliseconds; returns a function that stops it. */
  every(ms: number, fn: () => void): () => void;
}

/** Everything the hosting session touches outside its own logic. Tests swap in fakes. */
export interface SessionDeps {
  api: AgentApi;
  dataDir: string;
  log: (line: string) => void;
  ask: (question: string) => Promise<string>;
  address: () => string;
  build: (o: { profile: Profile; lock: Lockfile; dir: string }) => Promise<ServerMarker>;
  ensureEula: (serverDir: string) => Promise<boolean>;
  checkJava: (marker: ServerMarker) => void;
  launch: (dir: string, marker: ServerMarker) => ServerProcess;
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

/** "" takes the default; otherwise y/yes means yes. */
export function yes(answer: string, byDefault: boolean): boolean {
  const a = answer.trim().toLowerCase();
  return a === "" ? byDefault : a === "y" || a === "yes";
}

export const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
```

`apps/agent/src/host/sync.ts`:
```ts
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import type { SnapshotRef } from "@mc/protocol";
import { LeaseLostError, StaleRevError } from "./api";
import { DOWNLOAD_ATTEMPTS, UPLOAD_ATTEMPTS, type SessionDeps } from "./deps";
import { ChecksumError, extractSnapshot, zipSnapshot } from "./snapshot";
import { tmpDirFor } from "./state";

export class UploadFailedError extends UserError {}

/** upload-url → PUT → commit, retried with backoff. Lease problems are never retried. */
export async function pushZip(
  deps: Pick<SessionDeps, "api" | "upload" | "sleep">,
  o: { sessionId: string; baseRev: number; pregenDone: boolean },
  file: string,
  zipped: { sha256: string; size: number },
): Promise<number> {
  let last: Error | null = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const target = await deps.api.uploadUrl({ sessionId: o.sessionId, baseRev: o.baseRev, ...zipped });
      await deps.upload(target, file);
      return await deps.api.commit({ sessionId: o.sessionId, rev: target.rev, key: target.key, ...zipped, pregenDone: o.pregenDone });
    } catch (err) {
      if (err instanceof LeaseLostError || err instanceof StaleRevError) throw err;
      last = err as Error;
      if (attempt < UPLOAD_ATTEMPTS) await deps.sleep(5_000 * 4 ** (attempt - 1));
    }
  }
  throw new UploadFailedError(`Couldn't upload the world after ${UPLOAD_ATTEMPTS} tries (${last?.message}).`);
}

/** Zip a stopped server's snapshot paths and push them as the next rev. */
export async function uploadSnapshot(
  deps: Pick<SessionDeps, "api" | "upload" | "sleep" | "dataDir">,
  o: { sessionId: string; baseRev: number; serverDir: string; levelName: string; pregenDone: boolean },
): Promise<number> {
  const file = join(tmpDirFor(deps.dataDir), `upload-${o.baseRev + 1}.zip`);
  try {
    return await pushZip(deps, o, file, await zipSnapshot(o.serverDir, o.levelName, file));
  } finally {
    await rm(file, { force: true });
  }
}

/** Download a snapshot and unpack it over serverDir, retrying a damaged download. */
export async function fetchSnapshot(
  deps: Pick<SessionDeps, "download" | "log" | "dataDir">,
  latest: SnapshotRef,
  serverDir: string,
  levelName: string,
): Promise<void> {
  const file = join(tmpDirFor(deps.dataDir), `download-${latest.rev}.zip`);
  try {
    for (let attempt = 1; ; attempt++) {
      await deps.download(latest.url, file);
      try {
        await extractSnapshot(file, serverDir, levelName, latest.sha256);
        return;
      } catch (err) {
        if (!(err instanceof ChecksumError)) throw err;
        if (attempt >= DOWNLOAD_ATTEMPTS) throw new UserError("Couldn't download the world. Try again later.");
        deps.log("The downloaded world is damaged. Trying again…");
      }
    }
  } finally {
    await rm(file, { force: true });
  }
}
```

`apps/agent/src/host/prepare.ts`:
```ts
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseLock, parseProfile, UserError } from "@mc/profile";
import type { Manifest } from "@mc/protocol";
import type { ServerMarker } from "../server/build";
import { hhmm } from "./api";
import { mb, yes, type SessionDeps } from "./deps";
import { lastSaveTime, moveToRecovered, readState, serverDirFor, writeState } from "./state";
import { fetchSnapshot, uploadSnapshot } from "./sync";

export interface Prepared {
  world: Manifest["world"];
  sessionId: string;
  baseRev: number;
  serverDir: string;
  levelName: string;
  marker: ServerMarker;
  pregenDone: boolean;
  address: string;
  /** Remove prepare's Ctrl+C handler; the run phase installs its own. */
  unhook: () => void;
}

/**
 * Before claiming: if this PC's last session never finished uploading, decide whether its copy
 * can become the next rev (returns true) or must be set aside in recovered/ (returns false).
 */
async function recoveryCheck(deps: SessionDeps, manifest: Manifest, levelName: string): Promise<boolean> {
  const state = await readState(deps.dataDir);
  if (!state?.dirty) return false;
  const setAside = async (why: string) => {
    const dest = await moveToRecovered(deps.dataDir, state.worldId, deps.now());
    await writeState(deps.dataDir, { ...state, dirty: false });
    deps.log(dest ? `${why} Your copy was moved to ${dest} and won't be uploaded.` : why);
    return false;
  };
  if (state.worldId !== manifest.world.id) return setAside("Your last session was for a world that isn't active anymore.");
  const latestRev = manifest.latest?.rev ?? 0;
  if (latestRev !== state.baseRev) {
    return setAside(`Your last session didn't finish uploading, and someone has hosted since (the world is now at rev ${latestRev}).`);
  }
  if (manifest.lease && !manifest.lease.you) {
    return setAside(`Your last session didn't finish uploading, and ${manifest.lease.name} is hosting right now.`);
  }
  const saved = await lastSaveTime(serverDirFor(deps.dataDir, state.worldId), levelName);
  const answer = await deps.ask(
    `Your last session didn't finish uploading (last save ${saved === null ? "unknown" : hhmm(saved)}). Upload it now? [Y/n] `,
  );
  if (yes(answer, true)) return true;
  return setAside("Okay, it won't be uploaded.");
}

export async function prepare(deps: SessionDeps): Promise<Prepared> {
  const manifest = await deps.api.manifest();
  const { world } = manifest;
  const profile = parseProfile(manifest.profile, `the ${world.name} profile`);
  const lock = parseLock(JSON.stringify(manifest.lockfile), `the ${world.name} lockfile`);
  const levelName = String(profile.properties["level-name"] ?? "world");
  const serverDir = serverDirFor(deps.dataDir, world.id);

  let uploadLocal = await recoveryCheck(deps, manifest, levelName);
  await mkdir(serverDir, { recursive: true });
  // Ask about the EULA before claiming, so nobody holds the lease while reading it.
  if (!(await deps.ensureEula(serverDir))) throw new UserError("You need to agree to the EULA to host a server.");

  const address = deps.address();
  const claim = await deps.api.claim(address);
  const release = () => deps.api.release(claim.sessionId).catch(() => {});
  const unhook = deps.onStopSignal(() => {
    deps.log("Cancelled. Releasing the lease…");
    void release().then(() => deps.exit(130));
  });
  try {
    let baseRev = claim.baseRev;
    if (uploadLocal && baseRev !== (await readState(deps.dataDir))?.baseRev) {
      const dest = await moveToRecovered(deps.dataDir, world.id, deps.now());
      deps.log(`Someone uploaded a newer world a moment ago, so your copy was moved to ${dest} instead.`);
      uploadLocal = false;
    }
    if (uploadLocal) {
      deps.log("Uploading the world from your last session…");
      baseRev = await uploadSnapshot(deps, { sessionId: claim.sessionId, baseRev, serverDir, levelName, pregenDone: manifest.pregenDone });
      deps.log(`Uploaded as rev ${baseRev}.`);
    } else if (baseRev > 0) {
      const state = await readState(deps.dataDir);
      const upToDate = state?.worldId === world.id && state.baseRev === baseRev && existsSync(join(serverDir, levelName));
      if (!upToDate) {
        const latest = manifest.latest?.rev === baseRev ? manifest.latest : (await deps.api.manifest()).latest;
        if (!latest || latest.rev !== baseRev) throw new UserError("The world changed while starting. Run mc-host start again.");
        deps.log(`Downloading ${world.name} rev ${baseRev} (${mb(latest.size)} MB)…`);
        await fetchSnapshot(deps, latest, serverDir, levelName);
      }
    }
    await writeState(deps.dataDir, { worldId: world.id, baseRev, dirty: false });
    if (profile.datapacks.length || profile.resourcePack) {
      deps.log("Note: datapacks and the resource pack aren't supported yet, so this world runs without them.");
    }
    // Writes eula.txt again in case the folder was just moved aside and recreated.
    await deps.ensureEula(serverDir);
    const marker = await deps.build({ profile: { ...profile, datapacks: [] }, lock, dir: serverDir });
    deps.checkJava(marker);
    return { world, sessionId: claim.sessionId, baseRev, serverDir, levelName, marker, pregenDone: manifest.pregenDone, address, unhook };
  } catch (err) {
    unhook();
    await release();
    throw err;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test apps/agent/test/prepare.test.ts`
Expected: PASS (13 tests). The first test's event list is exact, so it fails if prepare makes an extra API call. Fix the code, not the test.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck`

```bash
git add apps/agent
git commit -F - <<'EOF'
feat(agent): hosting prepare phase with the recovery check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 13: The run phase (console, heartbeat, autosave, stop, crash) and `hostSession`

**Files:**
- Create: `apps/agent/src/host/run.ts`, `apps/agent/src/host/session.ts`
- Test: `apps/agent/test/hosted.test.ts`

**Interfaces:**
- Consumes:
  - `SessionDeps`, the timing constants, `PREGEN_RADIUS` and `yes` (Task 12)
  - `Prepared` and `prepare` (Task 12)
  - `pushZip` and `uploadSnapshot` (Task 12)
  - `ServerConsole` (Task 11)
  - `zipSnapshot` (Task 9)
  - `moveToRecovered`, `writeState` and `tmpDirFor` (Task 10)
  - `LeaseLostError` and `StaleRevError` (Task 8)
- Produces:
  - `runHosted(deps, prepared): Promise<void>`. It resolves after a clean stop, and throws `UserError` after a lost lease, a failed final upload or a crash.
  - `hostSession(deps): Promise<void>`

- [ ] **Step 1: Write the failing test**

`apps/agent/test/hosted.test.ts`:
```ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LeaseLostError } from "../src/host/api";
import { AUTOSAVE_MS, HEARTBEAT_MS } from "../src/host/deps";
import type { Prepared } from "../src/host/prepare";
import { runHosted } from "../src/host/run";
import { readState, serverDirFor } from "../src/host/state";
import { CHUNKY_DONE_LINE, DONE_LINE, makeHarness, manifestFor, MARKER, SESSION, until, type FakeServer } from "./host-fakes";

async function started(o: { rev?: number; pregenDone?: boolean; respond?: (line: string, s: FakeServer) => void } = {}) {
  const rev = o.rev ?? 0;
  const h = makeHarness(await manifestFor({ pregenDone: o.pregenDone }), { respond: o.respond });
  h.api.latestRev = rev;
  const serverDir = serverDirFor(h.deps.dataDir, "w1");
  mkdirSync(join(serverDir, "world"), { recursive: true });
  writeFileSync(join(serverDir, "world", "level.dat"), "live");
  let unhooked = false;
  const p: Prepared = {
    world: { id: "w1", name: "test", minecraft: "26.3" },
    sessionId: SESSION,
    baseRev: rev,
    serverDir,
    levelName: "world",
    marker: MARKER,
    pregenDone: o.pregenDone ?? false,
    address: "100.64.0.3",
    unhook: () => void (unhooked = true),
  };
  const done = runHosted(h.deps, p);
  done.catch(() => {});
  await until(() => h.servers.length === 1);
  return { h, p, done, server: h.servers[0]!, unhooked: () => unhooked };
}
const idx = (events: string[], e: string) => events.indexOf(e);

test("a full session: Done, pre-generation, heartbeat, autosave, then a clean stop", async () => {
  const { h, done, server, unhooked } = await started();
  expect(unhooked()).toBe(true);
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 0, dirty: true });

  server.emit(DONE_LINE);
  expect(h.logs).toContain("Hosting test. Players connect to 100.64.0.3:25565");
  expect(server.written).toEqual(["chunky radius 2000", "chunky start"]);

  h.timers.fire(HEARTBEAT_MS);
  await until(() => h.events.includes("api:heartbeat"));

  h.timers.fire(AUTOSAVE_MS);
  await until(() => h.events.includes("api:commit 1"));
  expect(idx(h.events, "server:save-off")).toBeLessThan(idx(h.events, "server:save-all flush"));
  expect(idx(h.events, "server:save-on")).toBeLessThan(idx(h.events, "api:uploadUrl 0"));
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 1, dirty: true });

  server.emit(CHUNKY_DONE_LINE);
  h.stop.fire();
  await done;
  expect(server.written.at(-1)).toBe("stop");
  expect(h.events).toContain("api:commit 2 pregen");
  expect(h.events.at(-1)).toBe("api:release");
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 2, dirty: false });
  expect(h.logs).toContain("World saved as rev 2. Hosting has stopped.");
  expect(h.stop.count).toBe(0);
  expect(h.forwarded.cb).toBeNull();
});

test("pre-generation continues on a later rev and is skipped once done", async () => {
  const later = await started({ rev: 2 });
  later.server.emit(DONE_LINE);
  expect(later.server.written).toEqual(["chunky continue"]);
  const finished = await started({ rev: 2, pregenDone: true });
  finished.server.emit(DONE_LINE);
  expect(finished.server.written).toEqual([]);
});

test("typed lines go to the server; a second Ctrl+C just says it's still stopping", async () => {
  const { h, server, done } = await started({ respond: () => {} });
  h.forwarded.cb!("say hi");
  expect(server.written).toEqual(["say hi"]);
  h.stop.fire();
  h.stop.fire();
  expect(h.logs).toContain("Still stopping, please wait…");
  server.exit(0);
  await done;
});

test("a lost lease (for example the same person hosting on a second PC) stops without uploading", async () => {
  const { h, done, server } = await started();
  h.api.heartbeatError = new LeaseLostError("This hosting session is no longer valid.");
  h.timers.fire(HEARTBEAT_MS);
  const err = await done.catch((e) => e);
  expect(server.written.some((l) => l.startsWith("say [mc-host] Someone else took over hosting"))).toBe(true);
  expect(server.written.at(-1)).toBe("stop");
  expect(err.message).toStartWith("This hosting session is no longer valid. Your copy of the world was moved to ");
  expect(h.events.some((e) => e.startsWith("api:uploadUrl"))).toBe(false);
  expect(readdirSync(join(h.deps.dataDir, "recovered"))).toHaveLength(1);
  expect((await readState(h.deps.dataDir))?.dirty).toBe(false);
});

test("a failed final upload keeps the lease and the dirty flag", async () => {
  const { h, done } = await started();
  h.api.uploadFailures = 3;
  h.stop.fire();
  const err = await done.catch((e) => e);
  expect(err.message).toBe(
    "Couldn't upload the world. Run `mc-host start` again when you're back online. Your progress is saved on this PC.",
  );
  expect(h.events).not.toContain("api:release");
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 0, dirty: true });
});

test("a crash while booting (before Done) defaults to keeping the last autosave", async () => {
  const { h, done, server } = await started();
  server.exit(1);
  const err = await done.catch((e) => e);
  expect(h.logs.join("\n")).toContain("Last 30 lines of logs/latest.log");
  expect(h.events).toContain("ask:The server crashed. Upload the world as it is? [y/N] ");
  expect(h.events.some((e) => e.startsWith("api:uploadUrl"))).toBe(false);
  expect(server.written).toEqual([]);
  expect(h.events).toContain("api:release");
  expect(err.message).toStartWith("The server crashed (exit code 1). A copy of the world is in ");
  expect(existsSync(join(h.deps.dataDir, "recovered"))).toBe(true);
  expect((await readState(h.deps.dataDir))?.dirty).toBe(false);
});

test("after a crash, answering y uploads the world as it is", async () => {
  const { h, done, server } = await started();
  h.answers.push("y");
  server.exit(1);
  await done.catch(() => {});
  expect(h.events).toContain("api:commit 1");
  expect(h.events.at(-1)).toBe("api:release");
});

test("Ctrl+C during an autosave upload waits for it, then uploads the next rev", async () => {
  const { h, done } = await started();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  h.deps.upload = async (target) => {
    h.events.push(`upload ${target.url}`);
    if (!h.events.includes("gate-passed")) {
      h.events.push("gate-passed");
      await gate;
    }
  };
  h.timers.fire(AUTOSAVE_MS);
  await until(() => h.events.includes("gate-passed"));
  h.stop.fire();
  await Bun.sleep(20);
  open();
  await done;
  const order = h.events.filter((e) => e.startsWith("api:uploadUrl") || e.startsWith("api:commit"));
  expect(order).toEqual(["api:uploadUrl 0", "api:commit 1", "api:uploadUrl 1", "api:commit 2"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/agent/test/hosted.test.ts`
Expected: FAIL. The error is "Cannot find module '../src/host/run'".

- [ ] **Step 3: Implement `run.ts` and `session.ts`**

`apps/agent/src/host/run.ts`:
```ts
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { LeaseLostError, StaleRevError } from "./api";
import { ServerConsole } from "./console";
import { AUTOSAVE_MS, HEARTBEAT_MS, PREGEN_RADIUS, SAVE_TIMEOUT_MS, yes, type SessionDeps } from "./deps";
import type { Prepared } from "./prepare";
import { zipSnapshot } from "./snapshot";
import { moveToRecovered, tmpDirFor, writeState } from "./state";
import { pushZip, uploadSnapshot } from "./sync";

const DONE = /\]: Done \(\d/;
const SAVED = /Saved the game/;
const CHUNKY_DONE = /\[Chunky\] Task finished for minecraft:overworld/;
/** 130/143: Java stopped by Ctrl+C or SIGTERM, which is a normal stop. */
const NORMAL_EXIT = new Set([0, 130, 143]);

const isLeaseProblem = (err: unknown): err is Error => err instanceof LeaseLostError || err instanceof StaleRevError;

export async function runHosted(deps: SessionDeps, p: Prepared): Promise<void> {
  const st = {
    baseRev: p.baseRev,
    pregenDone: p.pregenDone,
    lost: null as string | null,
    stopping: false,
    saving: null as Promise<void> | null,
  };
  const startedAt = deps.now();
  await writeState(deps.dataDir, { worldId: p.world.id, baseRev: st.baseRev, dirty: true });

  const server = deps.launch(p.serverDir, p.marker);
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
  // Stays installed until the very end, so Ctrl+C during the final upload can't abandon it.
  const unhookStop = deps.onStopSignal(() => stop("Stopping the server and saving the world. This can take a minute…"));
  p.unhook();
  try {
    deps.forwardInput((line) => con.send(line));

    const loseLease = (err: Error) => {
      if (st.lost) return;
      st.lost = err.message;
      con.send("say [mc-host] Someone else took over hosting. This server is stopping, and its world won't be saved to the cloud.");
      stop();
    };

    con.onLine((line) => {
      if (DONE.test(line)) {
        deps.log(`Hosting ${p.world.name}. Players connect to ${p.address}:25565`);
        if (!st.pregenDone) {
          if (p.baseRev === 0) {
            con.send(`chunky radius ${PREGEN_RADIUS}`);
            con.send("chunky start");
          } else {
            con.send("chunky continue");
          }
        }
      }
      if (CHUNKY_DONE.test(line)) st.pregenDone = true;
    });

    const stopHeartbeat = deps.timers.every(HEARTBEAT_MS, () => {
      deps.api.heartbeat(p.sessionId).catch((err) => {
        if (isLeaseProblem(err)) loseLease(err);
      });
    });

    const autosave = async () => {
      const file = join(tmpDirFor(deps.dataDir), "autosave.zip");
      try {
        const zipped = await (async () => {
          try {
            con.send("save-off");
            con.send("save-all flush");
            await con.waitFor(SAVED, SAVE_TIMEOUT_MS);
            return await zipSnapshot(p.serverDir, p.levelName, file);
          } finally {
            if (!st.stopping) con.send("save-on");
          }
        })();
        // Upload after save-on, so play isn't paused while it runs.
        st.baseRev = await pushZip(deps, { sessionId: p.sessionId, baseRev: st.baseRev, pregenDone: st.pregenDone }, file, zipped);
        await writeState(deps.dataDir, { worldId: p.world.id, baseRev: st.baseRev, dirty: true });
        deps.log(`Autosaved as rev ${st.baseRev}.`);
      } catch (err) {
        if (isLeaseProblem(err)) return loseLease(err);
        deps.log(`Warning: ${(err as Error).message} The server keeps running, and the next autosave tries again.`);
        con.send("say [mc-host] Couldn't back up the world to the cloud. Still trying.");
      } finally {
        await rm(file, { force: true });
      }
    };
    const stopAutosave = deps.timers.every(AUTOSAVE_MS, () => {
      if (st.stopping || st.saving) return;
      st.saving = autosave().finally(() => {
        st.saving = null;
      });
    });

    const code = await server.exited;
    stopHeartbeat();
    stopAutosave();
    deps.forwardInput(null);
    if (st.saving) await st.saving;

    if (st.lost) return await setAside(deps, p, st.baseRev, st.lost);
    if (NORMAL_EXIT.has(code)) return await finalUpload(deps, p, st);
    return await crashed(deps, p, st, code, startedAt);
  } finally {
    unhookStop();
  }
}

async function setAside(deps: SessionDeps, p: Prepared, baseRev: number, why: string): Promise<never> {
  const dest = await moveToRecovered(deps.dataDir, p.world.id, deps.now());
  await writeState(deps.dataDir, { worldId: p.world.id, baseRev, dirty: false });
  throw new UserError(`${why} Your copy of the world was moved to ${dest}.`);
}

async function finalUpload(deps: SessionDeps, p: Prepared, st: { baseRev: number; pregenDone: boolean }): Promise<void> {
  deps.log("Uploading the world…");
  try {
    st.baseRev = await uploadSnapshot(deps, {
      sessionId: p.sessionId,
      baseRev: st.baseRev,
      serverDir: p.serverDir,
      levelName: p.levelName,
      pregenDone: st.pregenDone,
    });
  } catch (err) {
    if (isLeaseProblem(err)) return setAside(deps, p, st.baseRev, err.message);
    // Keep the lease and the dirty flag: the next `mc-host start` offers this upload again.
    throw new UserError("Couldn't upload the world. Run `mc-host start` again when you're back online. Your progress is saved on this PC.");
  }
  await writeState(deps.dataDir, { worldId: p.world.id, baseRev: st.baseRev, dirty: false });
  await deps.api
    .release(p.sessionId)
    .catch((err) => deps.log(`Couldn't release the lease (${(err as Error).message}). It frees itself within 10 minutes.`));
  deps.log(`World saved as rev ${st.baseRev}. Hosting has stopped.`);
}

async function crashed(
  deps: SessionDeps,
  p: Prepared,
  st: { baseRev: number; pregenDone: boolean },
  code: number,
  startedAt: number,
): Promise<never> {
  deps.log(await deps.crashSummary(p.serverDir, startedAt));
  if (yes(await deps.ask("The server crashed. Upload the world as it is? [y/N] "), false)) {
    try {
      st.baseRev = await uploadSnapshot(deps, {
        sessionId: p.sessionId,
        baseRev: st.baseRev,
        serverDir: p.serverDir,
        levelName: p.levelName,
        pregenDone: st.pregenDone,
      });
      deps.log(`Uploaded as rev ${st.baseRev}.`);
    } catch (err) {
      deps.log(`Couldn't upload it: ${(err as Error).message}`);
    }
  }
  const dest = await moveToRecovered(deps.dataDir, p.world.id, deps.now());
  await writeState(deps.dataDir, { worldId: p.world.id, baseRev: st.baseRev, dirty: false });
  await deps.api.release(p.sessionId).catch(() => {});
  throw new UserError(`The server crashed (exit code ${code}). A copy of the world is in ${dest}. Run mc-host start to host again.`);
}
```

`apps/agent/src/host/session.ts`:
```ts
import type { SessionDeps } from "./deps";
import { prepare } from "./prepare";
import { runHosted } from "./run";

/** mc-host start: prepare (recovery, claim, download, build), then run until the server stops. */
export async function hostSession(deps: SessionDeps): Promise<void> {
  await runHosted(deps, await prepare(deps));
}
```

- [ ] **Step 3b: Check the test for the autosave that races a stop**

The test "Ctrl+C during an autosave upload…" depends on three things:
1. `stop()` sets `st.stopping` before the autosave's `finally`, so `save-on` isn't sent to a stopping server.
2. `runHosted` awaits `st.saving` after `server.exited`.
3. `finalUpload` reads `st.baseRev` after the autosave committed rev 1.

If the test sees `api:uploadUrl 0` twice, the final upload read `baseRev` before the autosave finished. Fix the ordering in `runHosted`, not the test.

- [ ] **Step 4: Run the tests**

Run: `bun test apps/agent/test/hosted.test.ts apps/agent/test/prepare.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole agent suite, typecheck and commit**

Run: `bun test apps/agent && bun run typecheck`
Expected: PASS.

```bash
git add apps/agent
git commit -F - <<'EOF'
feat(agent): hosting run phase with heartbeat, autosave, stop, crash and lease-loss handling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---
### Task 14: CLI wiring: `start`, `stop`, `status` and `mc-host admin`

**Files:**
- Modify: `apps/agent/src/cli.ts` (commands, usage, parsing, main), `apps/agent/src/commands.ts` (`Deps`, dispatch)
- Create: `apps/agent/src/host/commands.ts`, `apps/agent/src/admin.ts`
- Test: `apps/agent/test/cli.test.ts` (extend), `apps/agent/test/admin.test.ts`, `apps/agent/test/host-commands.test.ts`

**Interfaces:**
- Consumes:
  - `hostSession` (Task 13)
  - `SessionDeps` (Task 12)
  - `createAgentApi`, `createAdminApi` and `hhmm` (Task 8)
  - `loadHostConfig` and `loadAdminConfig` (Task 8)
  - `TerminalInput`, `spawnProcess` and `javaCommand` (Task 11)
  - `tailnetAddress` and `requireJava` (Task 10)
  - `downloadTo`, `uploadFile` and `zipSnapshot` (Task 9)
  - `buildServer`, `readMarker`, `ensureEula` and `crashSummary` (Phase 1)
  - `loadProfile` and `loadLock` (Phase 1, in `commands.ts`)
  - `mb` (Task 12)
- Produces:
  - `Command` kinds `start`, `stop`, `status`, `admin-world-create`, `admin-token-mint`, `admin-lease-release` and `admin-status`
  - `Deps` gains `env?` and `dataDir?`
  - `cmdStart(deps)`, `cmdStatus(deps)` and `cmdStop(deps)`
  - `runAdmin(cmd, deps)`

- [ ] **Step 1: Write the failing tests**

Append to `apps/agent/test/cli.test.ts`:
```ts
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
```

`apps/agent/test/admin.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProfile, profileHash, serializeLock, type Fetch } from "@mc/profile";
import { runAdmin } from "../src/admin";
import type { Deps } from "../src/commands";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function profilesDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mc-admin-profiles-"));
  const raw = {
    name: "test",
    description: "t",
    minecraft: "26.3",
    loader: { fabric: "latest-stable" },
    memory: { min: "2G", max: "4G" },
    mods: [{ modrinth: "lithium", side: "server" }],
  };
  writeFileSync(join(dir, "test.json"), JSON.stringify(raw));
  const profile = parseProfile(raw, "test.json");
  const lock = {
    lockfileVersion: 1 as const,
    profile: "test",
    profileHash: await profileHash(profile),
    minecraft: "26.3",
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files: [],
  };
  writeFileSync(join(dir, "test.lock.json"), serializeLock(lock));
  return dir;
}

function worker() {
  const seen: { method: string; url: string; body?: any }[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url, body });
    if (url.endsWith("/admin/worlds")) return json({ id: "w1", name: body.name }, 201);
    if (url.endsWith("/import-url")) {
      return json({ rev: 1, key: "worlds/w1/1-x.zip", url: "https://r2.test/put", headers: { "x-amz-checksum-sha256": "x" } });
    }
    if (url === "https://r2.test/put") return new Response(null, { status: 200 });
    if (url.endsWith("/import-commit")) return json({ rev: 1 });
    if (url.endsWith("/admin/tokens")) return json({ token: "t".repeat(43) }, 201);
    if (url.endsWith("/admin/lease/release")) {
      return json({ released: { name: "Alex", hostAddress: "100.64.0.3", claimedAt: 0, expiresAt: 0 } });
    }
    if (url.endsWith("/admin/status")) {
      return json({
        world: { id: "w1", name: "test-1", minecraft: "26.3", latestRev: 4, latestAt: null, pregenDone: true },
        lease: null,
        users: [{ discordId: "1", name: "Alex", revoked: false }, { discordId: "2", name: "Sam", revoked: true }],
      });
    }
    return json({ error: "not_found", message: "nope" }, 404);
  };
  return { fetch, seen };
}

function deps(fetch: Fetch, logs: string[], env: Record<string, string> = { MC_WORKER_URL: "https://w.test", MC_ADMIN_SECRET: "sec" }): Deps {
  return {
    fetch,
    cacheDir: mkdtempSync(join(tmpdir(), "mc-admin-cache-")),
    configDir: mkdtempSync(join(tmpdir(), "mc-admin-cfg-")),
    log: (l) => logs.push(l),
    ask: async () => "",
    env,
    now: () => new Date(2026, 8, 26, 12).getTime(),
  };
}

test("world create sends the profile and its lockfile, with a dated default name", async () => {
  const { fetch, seen } = worker();
  const logs: string[] = [];
  await runAdmin({ kind: "admin-world-create", profile: "test", replace: false, profilesDir: await profilesDir() }, deps(fetch, logs));
  expect(seen[0]!.url).toBe("https://w.test/admin/worlds");
  expect(seen[0]!.body).toMatchObject({ name: "test-2026-09-26", replace: false, imported: false, profile: { name: "test" }, lockfile: { profile: "test" } });
  expect(logs[0]).toContain("Created test-2026-09-26");
});

test("world create --import uploads the server folder as rev 1", async () => {
  const { fetch, seen } = worker();
  const srv = mkdtempSync(join(tmpdir(), "mc-import-"));
  mkdirSync(join(srv, "world"));
  writeFileSync(join(srv, "world", "level.dat"), "old world");
  const logs: string[] = [];
  await runAdmin({ kind: "admin-world-create", profile: "test", replace: true, importDir: srv, profilesDir: await profilesDir() }, deps(fetch, logs));
  expect(seen.map((s) => `${s.method} ${s.url.replace("https://w.test", "")}`)).toEqual([
    "POST /admin/worlds",
    "POST /admin/worlds/w1/import-url",
    "PUT https://r2.test/put",
    "POST /admin/worlds/w1/import-commit",
  ]);
  expect(seen[0]!.body).toMatchObject({ replace: true, imported: true });
  expect(seen[3]!.body).toEqual({ key: "worlds/w1/1-x.zip", size: seen[1]!.body.size, sha256: seen[1]!.body.sha256 });
  expect(logs.at(-1)).toContain("as rev 1");
});

test("--import pointed at the world folder itself fails before anything is created", async () => {
  const { fetch, seen } = worker();
  const worldDir = mkdtempSync(join(tmpdir(), "mc-worlddir-"));
  writeFileSync(join(worldDir, "level.dat"), "x");
  await expect(
    runAdmin({ kind: "admin-world-create", profile: "test", replace: false, importDir: worldDir, profilesDir: await profilesDir() }, deps(fetch, [])),
  ).rejects.toThrow("doesn't look like a server folder");
  expect(seen).toEqual([]);
});

test("token mint, lease release and status print what happened", async () => {
  const { fetch } = worker();
  const logs: string[] = [];
  const d = deps(fetch, logs);
  await runAdmin({ kind: "admin-token-mint", discordId: "123456789012345678", name: "Sam" }, d);
  await runAdmin({ kind: "admin-lease-release" }, d);
  await runAdmin({ kind: "admin-status" }, d);
  expect(logs).toContain(`Hosting token for Sam: ${"t".repeat(43)}`);
  expect(logs).toContain("Released Alex's lease (they were hosting at 100.64.0.3).");
  expect(logs.join("\n")).toContain("World: test-1 (Minecraft 26.3), rev 4");
  expect(logs).toContain("Hosting: nobody");
  expect(logs).toContain("Tokens: Alex, Sam (revoked)");
});

test("admin commands without MC_ADMIN_SECRET explain what's missing", async () => {
  await expect(runAdmin({ kind: "admin-status" }, deps(worker().fetch, [], {}))).rejects.toThrow("MC_ADMIN_SECRET");
});
```

`apps/agent/test/host-commands.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@mc/profile";
import { runCommand, type Deps } from "../src/commands";
import { manifestFor } from "./host-fakes";

function deps(fetch: Fetch, logs: string[], env: Record<string, string> = { MC_WORKER_URL: "https://w.test", MC_TOKEN: "tok" }): Deps {
  return {
    fetch,
    cacheDir: mkdtempSync(join(tmpdir(), "mc-hc-cache-")),
    configDir: mkdtempSync(join(tmpdir(), "mc-hc-cfg-")),
    dataDir: mkdtempSync(join(tmpdir(), "mc-hc-data-")),
    log: (l) => logs.push(l),
    ask: async () => "",
    env,
  };
}

test("status shows the world and who is hosting", async () => {
  const m = await manifestFor({ latest: { rev: 4, sha256: "a".repeat(64), size: 5 }, lease: { name: "Sam", hostAddress: "100.64.0.9", claimedAt: 0, expiresAt: 0, you: false } });
  const logs: string[] = [];
  await runCommand({ kind: "status" }, deps(async () => new Response(JSON.stringify(m)), logs));
  expect(logs[0]).toBe("World: test (Minecraft 26.3), rev 4");
  expect(logs[1]).toStartWith("Sam is hosting at 100.64.0.9:25565");
});

test("status says how to host when nobody is", async () => {
  const logs: string[] = [];
  await runCommand({ kind: "status" }, deps(async () => new Response(JSON.stringify(await manifestFor())), logs));
  expect(logs[1]).toBe("Nobody is hosting right now, run `mc-host start` to host.");
});

test("stop explains Ctrl+C", async () => {
  const logs: string[] = [];
  await runCommand({ kind: "stop" }, deps(async () => new Response(""), logs));
  expect(logs[0]).toContain("press Ctrl+C in the window where mc-host start is running");
});

test("start without a hosting config fails before touching the terminal", async () => {
  await expect(runCommand({ kind: "start" }, deps(async () => new Response(""), [], {}))).rejects.toThrow("isn't set up to host yet");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/agent/test/cli.test.ts apps/agent/test/admin.test.ts apps/agent/test/host-commands.test.ts`
Expected: FAIL with unknown command kinds and missing modules.

- [ ] **Step 3: Rewrite `cli.ts` with the new commands**

Replace everything in `apps/agent/src/cli.ts` above `async function main` with:
```ts
#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { UserError } from "@mc/profile";
import { runCommand } from "./commands";
import { cacheDir, configDir, dataDir } from "./paths";

export type Command =
  | { kind: "resolve"; name: string; check?: string; addReady: boolean; profilesDir: string }
  | { kind: "build-server"; name: string; dir: string; packsDir?: string; force: boolean; profilesDir: string }
  | { kind: "build-mrpack"; name: string; out: string; profilesDir: string }
  | { kind: "run"; dir: string }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "admin-world-create"; profile: string; name?: string; replace: boolean; importDir?: string; profilesDir: string }
  | { kind: "admin-token-mint"; discordId: string; name: string }
  | { kind: "admin-lease-release" }
  | { kind: "admin-status" }
  | { kind: "help" };

export const USAGE = `mc-host <command>

Hosting
  start
      Host the active world. Press Ctrl+C to stop and save it.
  stop
      How to stop hosting.
  status
      Show the active world and who is hosting.

Profiles
  profile resolve <profile> [--check <mc-version>] [--add-ready]
      Pin exact mod versions into profiles/<profile>.lock.json.
      --check        only report which mods exist for another Minecraft version
      --add-ready    move "waiting" mods that now have a build into "mods"
  profile build-server <profile> <dir> [--packs <folder>] [--force]
      Put the Fabric server, server-side mods and datapacks in <dir>.
      --force        build even if <dir> holds another profile's world
  profile build-mrpack <profile> <out.mrpack>
      Write a modpack that Prism Launcher can import.
  profile run <dir>
      Start a server folder made by build-server.

Maintainers (need MC_WORKER_URL and MC_ADMIN_SECRET)
  admin world create <profile> [--name <name>] [--replace] [--import <server-folder>]
      Make a new active world from profiles/<profile>.json and its lockfile.
      --replace      archive the current world first
      --import       upload an existing server folder as the world's first snapshot
  admin token mint <discord-id> <name>
      Print a new hosting token for someone. It's shown only once.
  admin lease release
      Free a stuck lease.
  admin status
      Show the active world, the lease and everyone with a token.

Options: --profiles <folder> (default: profiles)`;

export function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        check: { type: "string" },
        "add-ready": { type: "boolean", default: false },
        packs: { type: "string" },
        force: { type: "boolean", default: false },
        profiles: { type: "string", default: "profiles" },
        name: { type: "string" },
        replace: { type: "boolean", default: false },
        import: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new UserError(`${(err as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [group, sub, a, b, c] = positionals;
  if (values.help || !group) return { kind: "help" };
  const profilesDir = values.profiles ?? "profiles";
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new UserError(`Missing ${what}.\n\n${USAGE}`);
    return v;
  };
  const unknown = (words: (string | undefined)[]) =>
    new UserError(`Unknown command "${words.filter(Boolean).join(" ")}".\n\n${USAGE}`);

  switch (group) {
    case "start":
    case "stop":
    case "status":
      return { kind: group };
    case "profile":
      switch (sub) {
        case undefined:
          return { kind: "help" };
        case "resolve":
          return { kind: "resolve", name: need(a, "<profile>"), check: values.check, addReady: values["add-ready"] ?? false, profilesDir };
        case "build-server":
          return { kind: "build-server", name: need(a, "<profile>"), dir: need(b, "<dir>"), packsDir: values.packs, force: values.force ?? false, profilesDir };
        case "build-mrpack":
          return { kind: "build-mrpack", name: need(a, "<profile>"), out: need(b, "<out.mrpack>"), profilesDir };
        case "run":
          return { kind: "run", dir: need(a, "<dir>") };
        default:
          throw unknown(["profile", sub]);
      }
    case "admin":
      if (sub === "world" && a === "create") {
        return {
          kind: "admin-world-create",
          profile: need(b, "<profile>"),
          name: values.name,
          replace: values.replace ?? false,
          importDir: values.import,
          profilesDir,
        };
      }
      if (sub === "token" && a === "mint") {
        return { kind: "admin-token-mint", discordId: need(b, "<discord-id>"), name: need(c, "<name>") };
      }
      if (sub === "lease" && a === "release") return { kind: "admin-lease-release" };
      if (sub === "status") return { kind: "admin-status" };
      throw unknown(["admin", sub, a]);
    default:
      throw unknown([group]);
  }
}
```

In `main()`, change the `runCommand` call to pass the new fields:
```ts
    await runCommand(cmd, {
      fetch: (input, init) => fetch(input, init),
      cacheDir: cacheDir(),
      configDir: configDir(),
      dataDir: dataDir(),
      env: process.env,
      log: (line) => console.log(line),
      ask: async (q) => prompt(q) ?? "",
    });
```

- [ ] **Step 4: Add the hosting and admin commands**

In `apps/agent/src/commands.ts`:
1. Add these fields to `Deps`:
   ```ts
   /** Environment for MC_WORKER_URL / MC_TOKEN / MC_ADMIN_SECRET. Defaults to process.env. */
   env?: Record<string, string | undefined>;
   /** Where hosted worlds and local state live. Defaults to paths.dataDir(). */
   dataDir?: string;
   ```
2. Add these imports:
   ```ts
   import { runAdmin } from "./admin";
   import { cmdStart, cmdStatus, cmdStop } from "./host/commands";
   ```
3. Add these cases to `runCommand`'s switch:
   ```ts
    case "start":
      return cmdStart(deps);
    case "stop":
      return cmdStop(deps);
    case "status":
      return cmdStatus(deps);
    case "admin-world-create":
    case "admin-token-mint":
    case "admin-lease-release":
    case "admin-status":
      return runAdmin(cmd, deps);
   ```

`apps/agent/src/host/commands.ts`:
```ts
import { createInterface } from "node:readline";
import { USER_AGENT } from "@mc/profile";
import type { Deps } from "../commands";
import { dataDir as defaultDataDir } from "../paths";
import { crashSummary } from "../run/crash";
import { ensureEula } from "../run/eula";
import { requireJava } from "../run/java";
import { buildServer, readMarker } from "../server/build";
import { tailnetAddress } from "./address";
import { createAgentApi, hhmm } from "./api";
import { loadHostConfig, type HostConfig } from "./config";
import { javaCommand, spawnProcess } from "./console";
import type { SessionDeps } from "./deps";
import { hostSession } from "./session";
import { TerminalInput } from "./terminal";
import { downloadTo, uploadFile } from "./transfer";

function onStopSignal(handler: () => void): () => void {
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function sessionDeps(deps: Deps, cfg: HostConfig, input: TerminalInput): SessionDeps {
  const ask = (q: string) => input.ask(q, (text) => process.stdout.write(text));
  return {
    api: createAgentApi({ ...cfg, fetch: deps.fetch }),
    dataDir: deps.dataDir ?? defaultDataDir(),
    log: deps.log,
    ask,
    address: () => tailnetAddress(),
    build: async ({ profile, lock, dir }) => {
      await buildServer({ profile, lock, dir, fetch: deps.fetch, cacheDir: deps.cacheDir, userAgent: USER_AGENT, log: deps.log });
      return readMarker(dir);
    },
    ensureEula: (serverDir) => ensureEula({ configDir: deps.configDir, serverDir, ask, log: deps.log }),
    checkJava: (marker) => requireJava(marker, deps.javaBin),
    launch: (dir, marker) => spawnProcess(javaCommand(marker, deps.javaBin), dir, (text) => process.stdout.write(text)),
    forwardInput: (cb) => input.forwardTo(cb),
    download: (url, dest) => downloadTo(deps.fetch, url, dest),
    upload: (target, file) => uploadFile(deps.fetch, target, file),
    onStopSignal,
    crashSummary,
    now: deps.now ?? Date.now,
    sleep: (ms) => Bun.sleep(ms),
    timers: {
      every: (ms, fn) => {
        const t = setInterval(fn, ms);
        return () => clearInterval(t);
      },
    },
    exit: (code) => process.exit(code),
  };
}

export async function cmdStart(deps: Deps): Promise<void> {
  const cfg = await loadHostConfig(deps.env ?? process.env, deps.configDir);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    await hostSession(sessionDeps(deps, cfg, new TerminalInput(rl)));
  } finally {
    rl.close();
  }
}

export async function cmdStatus(deps: Deps): Promise<void> {
  const cfg = await loadHostConfig(deps.env ?? process.env, deps.configDir);
  const m = await createAgentApi({ ...cfg, fetch: deps.fetch }).manifest();
  deps.log(`World: ${m.world.name} (Minecraft ${m.world.minecraft}), rev ${m.latest?.rev ?? 0}`);
  deps.log(
    m.lease
      ? `${m.lease.you ? "You are" : `${m.lease.name} is`} hosting at ${m.lease.hostAddress}:25565 (since ${hhmm(m.lease.claimedAt)}).`
      : "Nobody is hosting right now, run `mc-host start` to host.",
  );
}

export async function cmdStop(deps: Deps): Promise<void> {
  deps.log(
    "To stop hosting, press Ctrl+C in the window where mc-host start is running. On Linux, the mc-host command from install.sh does this for you.",
  );
}
```

`apps/agent/src/admin.ts`:
```ts
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import type { Command } from "./cli";
import { loadLock, loadProfile, type Deps } from "./commands";
import { createAdminApi, hhmm, type AdminApi } from "./host/api";
import { loadAdminConfig } from "./host/config";
import { mb } from "./host/deps";
import { zipSnapshot } from "./host/snapshot";
import { uploadFile } from "./host/transfer";

type AdminCommand = Extract<Command, { kind: "admin-world-create" | "admin-token-mint" | "admin-lease-release" | "admin-status" }>;

function today(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function createWorld(cmd: Extract<AdminCommand, { kind: "admin-world-create" }>, api: AdminApi, deps: Deps): Promise<void> {
  const { profile } = await loadProfile(cmd.profilesDir, cmd.profile);
  const lock = await loadLock(cmd.profilesDir, cmd.profile, profile);
  const levelName = String(profile.properties["level-name"] ?? "world");
  if (cmd.importDir && !existsSync(join(cmd.importDir, levelName, "level.dat"))) {
    throw new UserError(
      `${cmd.importDir} doesn't look like a server folder: there's no ${levelName}/level.dat inside it. ` +
        `Point --import at the folder the server ran in (the one that contains ${levelName}/).`,
    );
  }
  const name = cmd.name ?? `${profile.name}-${today((deps.now ?? Date.now)())}`;
  const world = await api.createWorld({ name, profile, lockfile: lock, replace: cmd.replace, imported: Boolean(cmd.importDir) });
  deps.log(`Created ${world.name} from the ${profile.name} profile (Minecraft ${lock.minecraft}). It's the active world now.`);
  if (!cmd.importDir) return;

  const file = join(deps.cacheDir, "import", `${world.id}.zip`);
  try {
    const zipped = await zipSnapshot(cmd.importDir, levelName, file);
    const target = await api.importUrl(world.id, zipped);
    await uploadFile(deps.fetch, target, file);
    await api.importCommit(world.id, { key: target.key, ...zipped });
    deps.log(`Imported ${cmd.importDir} as rev 1 (${mb(zipped.size)} MB).`);
  } catch (err) {
    throw new UserError(
      `${world.name} was created, but importing ${cmd.importDir} failed: ${(err as Error).message} ` +
        "Fix the problem, then run the command again with --replace --name <a new name>.",
    );
  } finally {
    await rm(file, { force: true });
  }
}

export async function runAdmin(cmd: AdminCommand, deps: Deps): Promise<void> {
  const cfg = await loadAdminConfig(deps.env ?? process.env, deps.configDir);
  const api = createAdminApi({ ...cfg, fetch: deps.fetch });
  switch (cmd.kind) {
    case "admin-world-create":
      return createWorld(cmd, api, deps);
    case "admin-token-mint": {
      const token = await api.mintToken({ discordId: cmd.discordId, name: cmd.name });
      deps.log(`Hosting token for ${cmd.name}: ${token}`);
      deps.log("It's shown only once. Send it to them privately. Minting again replaces it.");
      return;
    }
    case "admin-lease-release": {
      const released = await api.releaseLease();
      deps.log(released ? `Released ${released.name}'s lease (they were hosting at ${released.hostAddress}).` : "Nobody was hosting.");
      return;
    }
    case "admin-status": {
      const s = await api.status();
      deps.log(
        s.world
          ? `World: ${s.world.name} (Minecraft ${s.world.minecraft}), rev ${s.world.latestRev}` +
              (s.world.latestAt ? ` saved at ${new Date(s.world.latestAt).toLocaleString()}` : "") +
              (s.world.pregenDone ? "" : ", not pre-generated yet")
          : "No world is active.",
      );
      deps.log(
        s.lease
          ? `Hosting: ${s.lease.name} at ${s.lease.hostAddress} since ${hhmm(s.lease.claimedAt)} (lease until ${hhmm(s.lease.expiresAt)})`
          : "Hosting: nobody",
      );
      deps.log(`Tokens: ${s.users.map((u) => (u.revoked ? `${u.name} (revoked)` : u.name)).join(", ") || "none"}`);
      return;
    }
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test apps/agent`
Expected: PASS, including the unchanged Phase 1 CLI tests.

- [ ] **Step 6: Build the binary, smoke-test the help and commit**

Run: `bun run --cwd apps/agent build && apps/agent/dist/mc-host --help | head -5 && bun run typecheck`
Expected: The binary builds. The help starts with `mc-host <command>`, followed by the Hosting section. No type errors.

```bash
git add apps/agent
git commit -F - <<'EOF'
feat(agent): mc-host start/stop/status and mc-host admin commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 15: Integration test against `wrangler dev`

**Files:**
- Create: `apps/agent/test/integration.test.ts`
- Modify: `package.json` (add a `test:integration` script)

**Interfaces:**
- Consumes:
  - `createAdminApi`, `createAgentApi` and `LeaseHeldError` (Task 8)
  - `downloadTo` and `uploadFile` (Task 9)
  - `serverDirFor` (Task 10)
  - `hostSession` (Task 13)
  - `AUTOSAVE_MS` (Task 12)
  - `makeHarness`, `manifestFor`, `worldFiles`, `FakeServer`, `DONE_LINE` and `until` (test fakes)
- Produces: `bun run test:integration`, which runs the real agent code (API client, transfers, zips, state, session) against a local Worker with D1 and the dev R2 proxy. Only the Minecraft server and the build step are faked.

- [ ] **Step 1: Write the test**

`apps/agent/test/integration.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { createAdminApi, createAgentApi, LeaseHeldError } from "../src/host/api";
import { AUTOSAVE_MS } from "../src/host/deps";
import { hostSession } from "../src/host/session";
import { serverDirFor } from "../src/host/state";
import { downloadTo, uploadFile } from "../src/host/transfer";
import { DONE_LINE, FakeServer, makeHarness, manifestFor, until, worldFiles } from "./host-fakes";

const RUN = process.env.INTEGRATION === "1";
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER_DIR = join(import.meta.dir, "..", "..", "worker");
let wrangler: Subprocess | undefined;

beforeAll(async () => {
  if (!RUN) return;
  const persist = mkdtempSync(join(tmpdir(), "mc-wrangler-"));
  const env = { ...process.env, CI: "1" };
  const migrate = Bun.spawnSync(["bunx", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: WORKER_DIR,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (migrate.exitCode !== 0) throw new Error("Applying the D1 migrations locally failed");
  wrangler = Bun.spawn(
    [
      "bunx", "wrangler", "dev", "--port", String(PORT), "--persist-to", persist,
      "--var", "ADMIN_SECRET:itest", "--var", "DEV_R2_PROXY:1",
      "--var", "R2_ACCESS_KEY_ID:unused", "--var", "R2_SECRET_ACCESS_KEY:unused",
    ],
    { cwd: WORKER_DIR, env, stdout: "ignore", stderr: "inherit" },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("wrangler dev didn't start within 60 seconds");
}, 90_000);

afterAll(() => {
  wrangler?.kill();
});

/** A hosting session with the real client and transfers; the server process is fake. */
async function host(token: string, writeWorld: string | null) {
  const h = makeHarness(await manifestFor());
  h.deps.api = createAgentApi({ workerUrl: BASE, token, fetch });
  h.deps.download = (url, dest) => downloadTo(fetch, url, dest);
  h.deps.upload = (target, file) => uploadFile(fetch, target, file);
  h.deps.launch = (dir) => {
    if (writeWorld !== null) {
      mkdirSync(join(dir, "world"), { recursive: true });
      writeFileSync(join(dir, "world", "level.dat"), writeWorld);
    }
    const s = new FakeServer(undefined, h.events);
    h.servers.push(s);
    return s;
  };
  return h;
}

test.skipIf(!RUN)("two hosts hand the world over through the real Worker", async () => {
  const admin = createAdminApi({ workerUrl: BASE, secret: "itest", fetch });
  const alex = await admin.mintToken({ discordId: "100000000000000001", name: "Alex" });
  const sam = await admin.mintToken({ discordId: "100000000000000002", name: "Sam" });
  const { profile, lockfile } = await worldFiles();
  const world = await admin.createWorld({ name: `itest-${Date.now()}`, profile, lockfile, replace: true });

  // Alex hosts, autosaves once, and Sam can't claim meanwhile.
  const a = await host(alex, "written by Alex");
  const runA = hostSession(a.deps);
  await until(() => a.servers.length === 1);
  a.servers[0]!.emit(DONE_LINE);
  a.timers.fire(AUTOSAVE_MS);
  await until(() => a.logs.includes("Autosaved as rev 1."), 15_000);
  await expect(createAgentApi({ workerUrl: BASE, token: sam, fetch }).claim("100.64.0.9")).rejects.toBeInstanceOf(LeaseHeldError);
  a.stop.fire();
  await runA;
  expect(a.logs).toContain("World saved as rev 2. Hosting has stopped.");

  // Sam hosts next and gets Alex's world.
  const b = await host(sam, null);
  const runB = hostSession(b.deps);
  await until(() => b.servers.length === 1, 15_000);
  expect(readFileSync(join(serverDirFor(b.deps.dataDir, world.id), "world", "level.dat"), "utf8")).toBe("written by Alex");
  b.stop.fire();
  await runB;

  const status = await admin.status();
  expect(status.world).toMatchObject({ id: world.id, latestRev: 3 });
  expect(status.lease).toBeNull();
}, 60_000);
```

Root `package.json` scripts: add `"test:integration": "INTEGRATION=1 bun test apps/agent/test/integration.test.ts"`.

- [ ] **Step 2: Check that it's skipped by default and passes when enabled**

Run: `bun test apps/agent/test/integration.test.ts`
Expected: 1 skipped.

Run: `bun run test:integration`
Expected: PASS, in roughly 10–30 seconds. If `wrangler dev` rejects a flag, run `bunx wrangler dev --help` in `apps/worker`, adjust the flag, and note the change in the commit message.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/test/integration.test.ts package.json
git commit -F - <<'EOF'
test: integration run of two hosts against wrangler dev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

---

### Task 16: Docker, `install.sh`, deployment guide, spec and roadmap

**Files:**
- Create: `infra/docker/Dockerfile`, `infra/docker/compose.yml`, `scripts/install.sh`, `docs/setup/phase-2.md`
- Modify: `docs/superpowers/specs/2026-09-26-phase-2a-hosting-design.md` (fold in the deviations), `ROADMAP.md`, `apps/worker/wrangler.jsonc` (real IDs, filled in during the manual deploy)

**Interfaces:**
- Consumes: the `mc-host` binary from `bun build --compile`, with `start` and `status` (Task 14).
- Produces:
  - Docker image `mc-host:local`
  - Compose project `mc-host` with the services `tailscale` and `agent`
  - The shim `~/.local/bin/mc-host`:
    - `start` runs the agent container in the foreground, named `mc-host-agent`
    - `stop` runs `docker kill -s SIGINT mc-host-agent`
    - `status` runs in the container
    - anything else goes to the native binary

- [ ] **Step 1: Write the Docker files**

`infra/docker/Dockerfile`:
```dockerfile
# Built by scripts/install.sh around a freshly compiled mc-host binary.
FROM eclipse-temurin:25-jre
COPY mc-host /usr/local/bin/mc-host
ENV MC_DATA_DIR=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache
WORKDIR /data
ENTRYPOINT ["mc-host"]
CMD ["start"]
```

`infra/docker/compose.yml`:
```yaml
# Installed to ~/.local/share/mc-host/compose.yml by scripts/install.sh.
# The agent shares the Tailscale sidecar's network namespace, so ports 25565 (game) and
# 24454/udp (voice chat) are reachable only through the Minecraft tailnet. Nothing is
# published on the host, and the host's own tailnet membership is untouched.
name: mc-host
services:
  tailscale:
    image: tailscale/tailscale:stable
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY}
      TS_HOSTNAME: ${TS_HOSTNAME}
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
    image: mc-host:local
    network_mode: service:tailscale
    depends_on: [tailscale]
    init: true
    stdin_open: true
    tty: true
    environment:
      MC_WORKER_URL: ${MC_WORKER_URL}
      MC_TOKEN: ${MC_TOKEN}
    volumes:
      - data:/data
    stop_grace_period: 5m
volumes:
  tailscale-state: {}
  data: {}
```

- [ ] **Step 2: Write `scripts/install.sh`**

`scripts/install.sh`:
```bash
#!/usr/bin/env bash
# Install mc-host for hosting from Linux: Docker + a Tailscale sidecar on the Minecraft tailnet.
# Run it from the repo checkout. Running it again is safe, and it can rotate the token or auth key.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install.sh --worker-url <url> --token <agent token> --authkey <tskey-...> [--name <host name>]

  --worker-url   the Worker's URL, e.g. https://mc-bot.<you>.workers.dev
  --token        your hosting token (mc-host admin token mint …)
  --authkey      a tagged, pre-authorized Tailscale auth key for the Minecraft tailnet
  --name         tailnet host name suffix (default: this machine's short hostname)

After the first install, every flag is optional; missing ones keep their current values.
EOF
}

WORKER_URL="" TOKEN="" AUTHKEY="" NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker-url) WORKER_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --authkey) AUTHKEY="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${XDG_DATA_HOME:-$HOME/.local/share}/mc-host"
BIN="$HOME/.local/bin"
ENV_FILE="$APP/.env"

command -v docker >/dev/null || { echo "Docker isn't installed. See https://docs.docker.com/engine/install/fedora/ (or /debian/), then run this again." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose isn't installed. Install the docker-compose-plugin package, then run this again." >&2; exit 1; }
command -v bun >/dev/null || { echo "Bun is needed to build mc-host. Install it from https://bun.sh, then run this again." >&2; exit 1; }

current() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
OLD_AUTHKEY="$(current TS_AUTHKEY)"
WORKER_URL="${WORKER_URL:-$(current MC_WORKER_URL)}"
TOKEN="${TOKEN:-$(current MC_TOKEN)}"
AUTHKEY="${AUTHKEY:-$OLD_AUTHKEY}"
HOSTNAME_NOW="$(current TS_HOSTNAME)"
TS_HOSTNAME="mc-${NAME:-$(hostname -s)}"
[[ -z "$NAME" && -n "$HOSTNAME_NOW" ]] && TS_HOSTNAME="$HOSTNAME_NOW"
if [[ -z "$WORKER_URL" || -z "$TOKEN" || -z "$AUTHKEY" ]]; then
  echo "The first install needs --worker-url, --token and --authkey." >&2
  usage >&2
  exit 1
fi

mkdir -p "$APP/build" "$BIN"
compose() { docker compose --project-directory "$APP" -f "$APP/compose.yml" --env-file "$ENV_FILE" "$@"; }

# A new auth key only takes effect on a fresh Tailscale state.
if [[ -n "$OLD_AUTHKEY" && "$AUTHKEY" != "$OLD_AUTHKEY" ]]; then
  echo "New auth key: resetting the Tailscale sidecar's state."
  compose down >/dev/null 2>&1 || true
  docker volume rm mc-host_tailscale-state >/dev/null 2>&1 || true
fi

(umask 077 && printf 'MC_WORKER_URL=%s\nMC_TOKEN=%s\nTS_AUTHKEY=%s\nTS_HOSTNAME=%s\n' \
  "$WORKER_URL" "$TOKEN" "$AUTHKEY" "$TS_HOSTNAME" > "$ENV_FILE")
chmod 600 "$ENV_FILE"

echo "Building mc-host…"
(cd "$REPO" && bun install --frozen-lockfile >/dev/null && bun build apps/agent/src/cli.ts --compile --outfile "$APP/build/mc-host" >/dev/null)
cp "$REPO/infra/docker/Dockerfile" "$APP/build/Dockerfile"
echo "Building the mc-host:local image…"
docker build -q -t mc-host:local "$APP/build" >/dev/null
cp "$REPO/infra/docker/compose.yml" "$APP/compose.yml"
cp "$APP/build/mc-host" "$APP/mc-host-native"

cat > "$BIN/mc-host" <<'SHIM'
#!/usr/bin/env bash
# Installed by minecraft-discord-bot/scripts/install.sh
set -euo pipefail
APP="${XDG_DATA_HOME:-$HOME/.local/share}/mc-host"
compose() { docker compose --project-directory "$APP" -f "$APP/compose.yml" --env-file "$APP/.env" "$@"; }
case "${1:-}" in
  start)
    exec compose run --rm -it --name mc-host-agent agent start ;;
  stop)
    if docker ps --format '{{.Names}}' | grep -qx mc-host-agent; then
      exec docker kill -s SIGINT mc-host-agent
    fi
    echo "Nobody is hosting from this PC." ;;
  status)
    exec compose run --rm -T agent status ;;
  *)
    exec "$APP/mc-host-native" "$@" ;;
esac
SHIM
chmod +x "$BIN/mc-host"

echo
echo "Installed. Host with: mc-host start   (Ctrl+C or 'mc-host stop' saves and stops)"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH to use the mc-host command." ;; esac
```

Run: `chmod +x scripts/install.sh && bash -n scripts/install.sh && (command -v shellcheck >/dev/null && shellcheck scripts/install.sh || echo "shellcheck not installed, skipped")`
Expected: no syntax errors. Shellcheck is clean, apart from warnings you have looked at and judged harmless.

Run: `docker compose -f infra/docker/compose.yml config -q && echo ok`
Expected: `ok`. Compose may warn that the variables aren't set, which is fine at this point.

- [ ] **Step 3: Write the deployment guide and manual checklist**

`docs/setup/phase-2.md`:
````markdown
# Phase 2a: Deploy the Worker and host from Fedora

Design: [../superpowers/specs/2026-09-26-phase-2a-hosting-design.md](../superpowers/specs/2026-09-26-phase-2a-hosting-design.md)

## 1. Create the D1 database and the R2 bucket

```bash
cd apps/worker
bunx wrangler login
bunx wrangler d1 create mc-bot          # copy the database_id it prints
bunx wrangler r2 bucket create mc-bot
```

Edit `apps/worker/wrangler.jsonc`:
- set `d1_databases[0].database_id` to the ID printed above
- set `vars.R2_ACCOUNT_ID` to your Cloudflare account ID (Dashboard → R2 → Overview, right-hand side)

Neither value is a secret, so commit them.

```bash
bunx wrangler d1 migrations apply DB --remote
```

## 2. Secrets

1. Dashboard → R2 → **Manage API tokens** → create a token with **Object Read & Write**, scoped to the `mc-bot` bucket.
2. Store the secrets. Each command prompts for its value, so nothing lands in your shell history:
   ```bash
   bunx wrangler secret put R2_ACCESS_KEY_ID
   bunx wrangler secret put R2_SECRET_ACCESS_KEY
   openssl rand -base64 32 | tr -d '\n' > /tmp/mc-admin-secret   # or any long random string
   bunx wrangler secret put ADMIN_SECRET < /tmp/mc-admin-secret
   ```
3. Put the Worker URL and the same admin secret in `~/.config/mc-host/admin.json` (mode 600):
   ```json
   { "workerUrl": "https://mc-bot.<you>.workers.dev", "secret": "<the admin secret>" }
   ```
   Then `shred -u /tmp/mc-admin-secret`.

## 3. Deploy

```bash
bunx wrangler deploy
curl -s https://mc-bot.<you>.workers.dev/health      # → ok
```

## 4. Your hosting token and the tailnet auth key

```bash
bun apps/agent/src/cli.ts admin token mint <your discord id> <your name>
```
In the Minecraft tailnet's admin console, go to Settings → Keys → **Generate auth key**:
- Reusable: off
- Ephemeral: off
- Pre-approved: on
- Tags: `tag:mc-player`

## 5. Install and import the Phase 1 world

```bash
scripts/install.sh --worker-url https://mc-bot.<you>.workers.dev --token <token> --authkey tskey-auth-…
mc-host admin world create adventure --import <the Phase 1 server folder>
mc-host admin status
```

## Manual checklist

- [ ] `mc-host status` shows the imported world at rev 1, with nobody hosting.
- [ ] `mc-host start` downloads rev 1, builds, prints "Hosting … Players connect to 100.x.y.z:25565".
- [ ] Join from another device on the Minecraft tailnet (a phone or laptop tagged `mc-player`) using that address.
- [ ] Typing `list` in the hosting terminal shows the players.
- [ ] Wait for an autosave, or temporarily edit `AUTOSAVE_MS`. The terminal says "Autosaved as rev 2" and `mc-host admin status` shows rev 2.
- [ ] **R2 checksum:** the autosave upload succeeded. That means R2 accepted the signed `x-amz-checksum-sha256` header. If R2 rejects it (HTTP 400/501 on the PUT), remove the header from `r2Storage().putTarget` and note it in the spec. Commit still checks the size, and the agent checks the sha256 on download.
- [ ] Ctrl+C: the server stops, "World saved as rev 3", and `mc-host admin status` shows nobody hosting.
- [ ] `mc-host start`, then from another terminal `docker kill mc-host-agent` partway through the session. The next `mc-host start` asks "Your last session didn't finish uploading … Upload it now? [Y/n]". Enter uploads it.
- [ ] `mc-host stop` from a second terminal stops a running session the same way Ctrl+C does.
- [ ] `mc-host admin world create vanilla-plus --replace`, then `mc-host start`. Chunky starts pre-generating (`chunky progress` in the console shows it).
````

- [ ] **Step 4: Fold the deviations into the spec, and update the roadmap**

In `docs/superpowers/specs/2026-09-26-phase-2a-hosting-design.md`:
1. **Components block:** change the `src/host/address.ts` line to `tailnet IPv4 from the network interfaces (100.64.0.0/10, preferring "tailscale*")`.
2. **Decisions table:** add a row: `| Local R2 | With DEV_R2_PROXY=1 the Worker hands out /dev/r2/<key> URLs that read and write the binding | Miniflare and wrangler dev have no S3 endpoint to presign against. Off in production. |`.
3. **Agent API table:**
   - `GET /agent/manifest` row: add "and the lease: `null`, or the holder's name, address and times plus `you`".
   - Commit row: change the request to `{sessionId, rev, key, size, sha256, pregenDone?}`, and say the sha256 is also checked when R2 reports one.
4. **Docker section:**
   - Remove the sentence about sharing the LocalAPI socket.
   - Replace "The data volume is mounted with `:Z` for SELinux." with "Data lives in named volumes, which need no SELinux relabeling."
   - Say the agent reads its tailnet IP from `tailscale0`, which it sees because it shares the sidecar's network namespace.

In `ROADMAP.md`, tick the Phase 2a items that are now built:
- Worker skeleton
- Agent API
- Admin API
- `mc-host start/stop`
- `install.sh`

Leave "Deploy, then host the imported `adventure` world from Fedora" unticked until the manual checklist passes.

- [ ] **Step 5: Run everything and commit**

Run: `bun run test && bun run typecheck`
Expected: all Bun and Worker tests PASS, with no type errors.

```bash
git add infra/docker scripts/install.sh docs/setup/phase-2.md docs/superpowers/specs/2026-09-26-phase-2a-hosting-design.md ROADMAP.md
git commit -F - <<'EOF'
feat: Linux install with Docker and a Tailscale sidecar; phase 2a deployment guide

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
EOF
```

- [ ] **Step 6: Hand the manual deployment to the maintainer**

Steps 1–5 of `docs/setup/phase-2.md` need the maintainer's Cloudflare login, Discord ID and Tailscale admin console, so an agent can't do them. Stop here and report:
- which tests pass
- that the guide is ready

After the maintainer finishes the guide:
- commit the real IDs in `apps/worker/wrangler.jsonc`
- tick the last Phase 2a roadmap item
