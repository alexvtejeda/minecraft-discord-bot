# Phase 2a: Hosting core — Design

Date: 2026-09-26
Status: Approved design
Parent design: [2026-09-25-minecraft-discord-bot-design.md](2026-09-25-minecraft-discord-bot-design.md)
Previous phase: [2026-09-25-phase-1-profiles-design.md](2026-09-25-phase-1-profiles-design.md)

## Goal

Anyone with an agent token can run `mc-host start` to host the active world. The world
comes down from R2 and goes back up on autosave and on stop, and it never forks. This
phase covers the Worker (D1 and R2), the agent API, the agent's hosting session, and a
Linux install that runs the agent in Docker with a Tailscale sidecar. Discord commands are
not part of it. A maintainer drives everything through `mc-host admin`.

## How Phase 2 is split

| Part | Contents | Where |
|---|---|---|
| **2a (this spec)** | Worker, D1 and R2, agent API, admin API and CLI, hosting session, `install.sh` | here |
| 2b | Portable JDK per Minecraft version (Windows needs it, Docker doesn't); the `pack_format` check in `build-server` | its own small plan |
| Moved to Phase 4 | `install.ps1`, because it needs `/setup` enrollment codes | ROADMAP |
| Moved to Later | Datapacks and resource packs in R2, and the Worker serving the resource pack by hash. This waits until Vanilla Tweaks ships 26.3 packs. | ROADMAP |

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Bootstrap before Discord commands | Admin routes on the Worker, protected by `ADMIN_SECRET`, and called from `mc-host admin` | The logic for world creation and token minting is written once. `/world new` (Phase 3) and `/setup` (Phase 4) become thin wrappers around it. |
| World contents | The profile and lockfile are copied into D1 when the world is created | A world stays pinned to the lockfile it was created with, even if the repo changes later. Hosts don't need the repo. |
| Snapshot contents | `world/`, `config/`, `ops.json`, `banned-players.json`, `banned-ips.json`, `usercache.json` | Everything else is rebuilt on each start from the pinned lockfile. Uploads stay small, no mod jars go into R2, and mod config edits survive a change of host. |
| Importing a world | `admin world create --import <world-dir>` commits the folder as rev 1 | Brings in the Phase 1 test world, or any older world. |
| Chunky pre-generation | Automatic on a fresh world's first start (radius 2000). Imported worlds skip it. | Structure mods added later only affect chunks that haven't been generated. |
| Datapacks and resource pack | Left out for now. The agent skips the resource pack and prints a note. | Vanilla Tweaks has no 26.3 packs yet, and the resource pack is optional. |
| Linux hosting | Runs in the foreground: `mc-host start` runs `docker compose run -it` in your terminal | The same experience as on Windows, and the server console stays usable. |
| Console | The agent owns the server's stdin. It forwards your typed lines and injects its own save commands. | Both are needed: autosave has to send `save-off` and friends, and the host has to be able to type commands. |
| Java in Docker | `eclipse-temurin:25-jre` base image | 2a doesn't depend on the portable JDK work in 2b. |
| Lease expiry | Checked lazily, whenever a claim or status request comes in. No cron. | There are no announcements until Phase 3, so nothing needs to happen at the moment of expiry. |
| Worker routing | Hono, with zod schemas shared through `packages/protocol` | Small, typed, and the agent and the Worker can't drift apart. |
| Local R2 | With DEV_R2_PROXY=1 the Worker hands out /dev/r2/<key> URLs that read and write the binding | Miniflare and wrangler dev have no S3 endpoint to presign against. Off in production. |

## Components

```
packages/protocol/   NEW  zod schemas for every agent and admin request and response
apps/worker/         NEW  Cloudflare Worker (wrangler)
  src/index.ts            Hono app, bearer-auth middleware
  src/routes/agent.ts     agent routes (Bearer <agent token>)
  src/routes/admin.ts     admin routes (Bearer ADMIN_SECRET)
  src/lease.ts            claim/heartbeat/release as conditional D1 updates
  src/worlds.ts           create/activate/archive, snapshot commit and retention
  src/r2presign.ts        presigned GET/PUT through R2's S3 API (aws4fetch)
  migrations/0001_init.sql
apps/agent/          EXISTING, gains:
  src/host/api.ts         typed Worker client
  src/host/session.ts     start → run → autosave → stop state machine
  src/host/console.ts     stdin multiplexer
  src/host/snapshot.ts    streaming zip/unzip and sha256
  src/host/state.ts       local state.json
  src/host/address.ts     tailnet IPv4 from the network interfaces (100.64.0.0/10, preferring "tailscale*")
  src/admin.ts            `mc-host admin …`
infra/docker/        NEW  Dockerfile, compose.yml
scripts/install.sh   NEW  Linux installer and the `mc-host` shim
docs/setup/phase-2.md NEW deployment guide and manual checklist
```

The existing `cli.ts` gains the `start`, `stop`, `status` and `admin` command groups. The
Phase 1 `profile …` commands are unchanged.

## Data model (D1)

```sql
worlds    (id TEXT PK, name TEXT UNIQUE, mc_version TEXT, profile_json TEXT,
           lockfile_json TEXT, status TEXT CHECK (status IN ('active','archived')),
           pregen_done INTEGER, created_at INTEGER)
snapshots (world_id TEXT, rev INTEGER, r2_key TEXT, size INTEGER, sha256 TEXT,
           uploaded_by TEXT, created_at INTEGER, PRIMARY KEY (world_id, rev))
lease     (id INTEGER PK CHECK (id = 1), holder_id TEXT, session_id TEXT,
           world_id TEXT, base_rev INTEGER, host_address TEXT,
           claimed_at INTEGER, expires_at INTEGER)
users     (discord_id TEXT PK, name TEXT, token_hash TEXT UNIQUE,
           created_at INTEGER, revoked_at INTEGER)
```

- A partial unique index keeps at most one world `active`.
- The lease row always exists. An empty lease has `holder_id = NULL`.
- The profile and lockfile are kilobytes, well under D1's row limit. `world create` still
  rejects anything over 1 MB.
- Tokens are 32 random bytes, base64url-encoded. Only their sha256 is stored.

R2 keys are `worlds/<world-id>/<rev>-<uuid>.zip`. The uuid makes an abandoned upload
distinct from the one that finally gets committed.

## Agent API

All routes take `Authorization: Bearer <agent token>`. The token is hashed and looked up
in `users`, and a revoked or unknown token gets a 401.

| Route | Behavior |
|---|---|
| `GET /agent/manifest` | Returns the active world (id, name, MC version), its profile and lockfile, `pregen_done`, and the latest snapshot as `{rev, sha256, size, url}` with a 1-hour presigned GET, or `null` at rev 0, and the lease: `null`, or the holder's name, address and times plus `you`. With no active world, a 404 saying a maintainer needs to create one. |
| `POST /agent/lease/claim {hostAddress}` | A single conditional `UPDATE … WHERE holder_id IS NULL OR expires_at < now OR holder_id = me`. On success, it sets a new random `session_id`, `base_rev` = latest rev, and `expires_at` = now + 10 min. On failure, a 409 with the holder's name, address and claim time. |
| `POST /agent/lease/heartbeat {sessionId}` | Needs the current `session_id`. Sets `expires_at` = now + 10 min. A 409 `lease_lost` otherwise. |
| `POST /agent/snapshot/upload-url {sessionId, baseRev, size, sha256}` | Needs the current session, and `baseRev` must equal the latest rev. Returns `rev = baseRev + 1`, the key, and a presigned PUT with `x-amz-checksum-sha256` signed in, so R2 rejects a body that doesn't match. |
| `POST /agent/snapshot/commit {sessionId, rev, key, size, sha256, pregenDone?}` | Needs the current session and `rev = latest + 1`. HEADs the object and checks the size, and the sha256 too when R2 reports one. Then, in one D1 batch: insert the snapshot row, set `lease.base_rev = rev`, and set `pregen_done` if it was reported. Afterwards it prunes: keeps the last 5 snapshots and deletes older objects plus any objects under the world's prefix that have no row. |
| `POST /agent/lease/release {sessionId}` | Needs the current session. Clears the lease. |

**The session ID is the core safety rule.** Every write needs the `session_id` from the
latest claim, including when the same person re-claims. A process left over from a
crashed session can't heartbeat, commit or release, so it can't write over the world or
fork it.

## Admin API and CLI

The routes take `Authorization: Bearer <ADMIN_SECRET>`. The CLI reads `MC_WORKER_URL` and
`MC_ADMIN_SECRET` from the environment, or from `configDir/admin.json`. It runs natively
on the maintainer's machine, because it reads `profiles/` from the checkout.

| CLI | Route | Behavior |
|---|---|---|
| `mc-host admin world create <profile> [--name <n>] [--replace] [--import <dir>]` | `POST /admin/worlds` | Reads the profile and lockfile, and refuses a lockfile whose `profileHash` doesn't match the profile. Fails if a world is already active, unless `--replace` is passed. `--replace` archives the current world, keeping only its latest snapshot, and fails while the lease is held. The name defaults to `<profile>-<yyyy-mm-dd>`. |
| (part of `--import`) | `POST /admin/worlds/:id/import-url`, `/import-commit` | Only allowed while the world is at rev 0 and the lease is free. Zips the folder the same way `snapshot.ts` does for a server folder, and commits it as rev 1 with `pregen_done = 1`. |
| `mc-host admin token mint <discord-id> <name>` | `POST /admin/tokens` | Creates the user row if needed and prints the plaintext token once. Minting again replaces the old token. |
| `mc-host admin lease release` | `POST /admin/lease/release` | Clears a stuck lease. |
| `mc-host admin status` | `GET /admin/status` | Shows the active world, the latest rev and its age, the lease holder, address and expiry, and the list of users. |

## Hosting session (`mc-host start`)

Local layout: `dataDir/<world-id>/server/` holds the built server, `dataDir/state.json`
holds `{worldId, baseRev, dirty}`, and `dataDir/recovered/<timestamp>/` holds local
copies that were set aside instead of uploaded. `dataDir` is a Docker volume on Linux and
lives under `%LOCALAPPDATA%\mc-host` on Windows.

### The `dirty` flag

`dirty` means "this machine's copy of the world may be newer than the cloud's". It's set
just before Java launches and cleared only after the final upload at stop has been
committed. If it's still set at the next `mc-host start` on the same machine, the last
session ended without its final upload. The usual causes are a crash, a power cut, a
closed terminal, or no internet at stop time.

### Start

1. Fetch the manifest and read `state.json`.
2. **Recovery check.** This only runs when `dirty` is set and `state.worldId` is the
   active world:
   - The latest rev equals `state.baseRev` and the lease is free, expired or held by this
     user: ask *"Your last session didn't finish uploading (last save HH:MM). Upload it
     now? [Y/n]"*. Yes means the local copy is uploaded as the next rev right after the
     claim, and the session carries on with that copy, skipping step 4. No means it's
     moved to `recovered/`.
   - Anything else (someone has hosted since, or the lease is held by someone else): move
     it to `recovered/` and explain why. It is never uploaded automatically.
   - If `dirty` is set for a world that's no longer active, the local copy is moved to
     `recovered/`.
3. Claim the lease, sending the tailnet IPv4 address.
4. If the local `baseRev` is behind the latest rev: download the snapshot, check its
   sha256 *before* extracting, clear the snapshot paths from the server folder, and
   extract.
5. Run `build-server` (from Phase 1) from the world's pinned lockfile, with jars coming
   from the cache. Leave the resource pack out and print a note.
6. Write `dirty = true`, then launch Java with piped stdin.

Any failure in steps 3–6 releases the lease before the agent exits.

### Running

- **Console multiplexer.** Lines from the terminal go to the server's stdin, and server
  output passes through to the terminal. Injected commands are queued between whole
  lines, so the two never interleave. The agent watches the output for `Done (`,
  `Saved the game` and Chunky's task-finished line.
- **Pre-generation.** If `pregen_done` is false, the agent waits for `Done (` and then
  sends `chunky radius 2000` and `chunky start` on a world at rev 0. At rev 1 or later it
  sends `chunky continue`, because an earlier host started the task and Chunky saves its
  progress in `config/`, which is part of the snapshot. Completion is sent as `pregenDone` on the next commit.
- **Heartbeat** every 2 minutes. Network errors are retried quietly. A 409 `lease_lost`
  means someone else now holds the lease. The agent then `say`s a warning in-game, stops
  the server, moves the local world to `recovered/`, clears `dirty`, and exits with an
  explanation.
- **Autosave** every 30 minutes:
  1. `save-off`, then `save-all flush`, then wait for `Saved the game`.
  2. Zip the snapshot paths to a temp file in `dataDir`, streaming rather than holding
     the zip in memory.
  3. `save-on`.
  4. Upload and commit. This comes after `save-on` so play isn't paused while it runs.

  Uploads retry with exponential backoff. After 3 failures in a row the agent warns in
  the console and in-game, and it keeps trying at the next autosave.

### Stop

- **Ctrl+C, or `stop` typed in the console.** The agent sends `stop` if it hasn't already,
  waits for Java to exit, zips, uploads, commits, writes `dirty = false`, and releases the
  lease.
- **The final upload keeps failing.** The lease is not released and `dirty` stays set.
  The agent prints "Couldn't upload the world. Run `mc-host start` again when you're back
  online. Your progress is saved on this PC." The next start's recovery check offers the
  upload. The lease expires 10 minutes after the last heartbeat. Until then nobody else
  can claim it, and after that the recovery check still works as long as nobody else has
  committed.
- **The server crashes (non-zero exit).** The agent prints the crash report path and asks
  *"Upload the world as it is? [y/N]"*. It defaults to keeping the last autosave. Either
  way the local copy is kept in `recovered/`, `dirty` is cleared, and the lease is
  released.

### `mc-host stop` and `mc-host status`

`status` shows the manifest summary and the lease holder. `stop` exists for the Linux
shim. The shim starts the container with `--name mc-host-agent`, and `stop` runs
`docker kill -s SIGINT mc-host-agent`, which does the same as pressing Ctrl+C in the
hosting terminal. With no container running, it says nobody is hosting from this PC. On
Windows, `stop` prints "Press Ctrl+C in the hosting window."

## Linux hosting

### Docker (`infra/docker/`)

- **`tailscale` service.** The `tailscale/tailscale` image in kernel mode (`/dev/net/tun`,
  `NET_ADMIN`), with state in a named volume. It joins the Minecraft tailnet with
  `TS_AUTHKEY` and hostname `mc-<name>`. The Fedora host's own tailnet membership is
  untouched.
- **`agent` service.** It runs on `eclipse-temurin:25-jre` with the compiled `mc-host`
  binary, and uses `network_mode: service:tailscale`. Ports 25565 (TCP) and 24454 (UDP,
  voice chat) are therefore reachable only through the Minecraft tailnet, and nothing is
  published on the host. Data lives in named volumes, which need no SELinux relabeling. The agent reads its tailnet IP from
  `tailscale0`, which it sees because it shares the sidecar's network namespace. It has
  `init: true`, so Ctrl+C from `docker compose run -it` reaches the agent cleanly.

### `scripts/install.sh`

It runs from the repo checkout. The one-line delivery through `/setup` comes in Phase 4.

```
./scripts/install.sh --worker-url https://<worker>.workers.dev --token <agent token> --authkey tskey-…
```

1. Checks for Docker and Compose. If either is missing, it prints how to install it on
   Fedora or Debian and exits.
2. Builds `mc-host` with `bun build --compile` and builds the image.
3. Writes `~/.local/share/mc-host/compose.yml` and `.env` (mode 600).
4. Writes the shim `~/.local/bin/mc-host`. `start` runs
   `docker compose run --rm -it --name mc-host-agent agent mc-host start`. `stop` and `status` are passed
   through. `admin` and `profile` run the native binary.
5. Skips steps that are already done. Re-running it with new flags rotates the token or
   the auth key.

The tagged auth key (`tag:mc-player`, pre-authorized, reusable off) is created by hand in
the Tailscale admin console for now.

### Deployment (`docs/setup/phase-2.md`)

1. `wrangler d1 create`, `wrangler r2 bucket create`, and `wrangler d1 migrations apply`.
2. Create an R2 S3 API token scoped to the bucket. Then `wrangler secret put` for
   `ADMIN_SECRET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
3. `wrangler deploy`.
4. `mc-host admin token mint`, then create an auth key and run `install.sh`.
5. `mc-host admin world create adventure --import <phase 1 world>`.

## Error handling

Errors follow the parent spec's rule: plain English that says what to do next. Examples:

| Situation | Message |
|---|---|
| Lease held | "Alex is already hosting at 100.64.0.3 (since 20:14)." |
| No active world | "No world is active yet. A maintainer runs `mc-host admin world create <profile>`." |
| Bad token | "Your token was rejected. Ask a maintainer for a new one." |
| Worker unreachable at start | "Can't reach the server list at <url>. Check your internet connection and try again." |
| sha256 mismatch on download | "The downloaded world is damaged. Trying again…", then after 3 attempts "Couldn't download the world. Try again later." |
| Stale `baseRev` on upload | Handled like `lease_lost`. It can only happen if the lease changed hands. |
| Snapshot over the Worker's limit | Not possible: uploads go straight to R2 through presigned URLs. |

## Testing

### Worker

Vitest with `@cloudflare/vitest-pool-workers`, with D1 and R2 emulated by Miniflare.

- **Lease:**
  - claim when the lease is free, taken, expired, or already yours
  - two concurrent claims, where exactly one wins
  - heartbeat or release with a stale `session_id` is rejected
  - expiry is evaluated lazily
- **Snapshots:**
  - `upload-url` is rejected for a stale `baseRev`
  - commit is rejected for the wrong rev, a stale session, a missing object, or a size
    mismatch
  - retention keeps exactly 5 and removes orphans
  - `pregen_done` is set on commit
- **Admin:**
  - `world create` rejects a lockfile hash mismatch and enforces a single active world
  - `--replace` archives the current world and fails while the lease is held
  - import only works at rev 0 with the lease free
  - a minted token authenticates, and a re-minted token invalidates the old one
- **Auth:** a missing or wrong bearer on every route family.
- **Presign:** URL and signature shape against a fixed clock, with the checksum header
  signed.

### Agent

`bun test`, as in Phase 1.

- **Session state machine**, run with a fake API client and a fake server process
  (scripted stdout, captured stdin). It covers:
  - the happy path
  - the recovery matrix: dirty or clean × cloud moved on or not × lease free or held ×
    world still active or not
  - `lease_lost` in the middle of a session
  - autosave ordering (`save-on` is sent before the upload)
  - final upload failing, which keeps the lease and `dirty`
  - a crash exit
  - a failure before launch, which releases the lease
- **Console multiplexer:** no interleaving within a line, and it waits for
  `Saved the game`.
- **Snapshot:** a round trip includes exactly the snapshot paths, and a sha256 mismatch
  is rejected before extracting.
- **Admin CLI:** argument parsing and the lockfile hash check.

### Integration

One script: `wrangler dev` plus the real agent against a fake server (a shell script that
writes a `world/` folder, prints `Done (`, and answers `save-all flush` and `stop`). It
covers:

- create, claim, autosave and stop, then a second agent downloading rev 2
- a second agent's claim being refused while the first holds the lease

### Manual checklist (`docs/setup/phase-2.md`)

Done on Fedora:

1. Deploy, run `install.sh`, and import the Phase 1 `adventure` world.
2. Join from another device on the Minecraft tailnet.
3. Run a console command. Let an autosave happen and check that the rev goes up.
4. Stop with Ctrl+C and check that the lease is released.
5. `docker kill` the agent in the middle of a session, then start again and check that
   the recovery prompt appears and its upload works.
6. Create a fresh world with `--replace` and check that Chunky pre-generates it.

## Out of scope for 2a

- Discord interactions and announcements (Phase 3)
- `install.ps1`, enrollment codes and minting auth keys (Phase 4)
- The portable JDK and the `pack_format` check (2b)
- Datapacks and resource packs in R2 (Later)
- A release pipeline for prebuilt binaries (Phase 4, with `install.ps1`)
