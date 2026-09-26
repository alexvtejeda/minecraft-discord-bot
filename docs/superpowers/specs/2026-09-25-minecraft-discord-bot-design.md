# Minecraft Discord Bot — Design

Date: 2026-09-25
Status: Approved architecture; Phase 1 detail pending its own brainstorm

## Goal

Let a small group of friends (< 10 concurrent players, sporadic ~2-week worlds) run a
modded Minecraft server with **no paid hosting and no always-on machine**. Anyone in the
group can host from their own PC; the world never forks or gets lost; everything is driven
from Discord slash commands; friends never drag files into folders by hand. The repo is
public and reusable for future worlds and Minecraft versions.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Bot runtime | Cloudflare Worker using HTTP interactions | Always online at $0 without an always-on machine. |
| File storage | Cloudflare R2, accessed through presigned URLs (1h expiry) | Worlds and modpacks exceed Discord's upload limit. The free tier has 10 GB and no egress fees. |
| State | Cloudflare D1 (SQLite) | Host lock, worlds, mods, users. |
| Mod platform | Fabric | Server-only mods are possible, and players choose their own client mods. |
| World sync | A single host lease plus full-zip snapshots | Simple and robust at 50–300 MB world sizes. |
| Network | Dedicated Tailscale tailnet (new account) | Headscale is deferred until later. |
| Tailnet join | Tagged, pre-authorized auth keys minted by the Worker | Friends don't need a Tailscale account. |
| "Chat" | Announcements only | A two-way chat bridge is deferred. |
| Language | TypeScript everywhere. The agent is compiled to a standalone binary with Bun. | Protocol types are shared between the Worker and the agent. |

### Known trade-offs

- **Tagged player devices.** Tailscale says tags are meant for servers, not personal
  devices, because a tagged device has no owner and stays in the tailnet after its person
  leaves. We accept this because the tailnet is used only for Minecraft and the ACL
  exposes nothing except the game port. `/tailnet revoke` deletes a user's devices.
- **The R2 free tier requires a card on file.** Usage stays within the free limits.
- **The maintainer's Fedora box is already on another tailnet.** On Linux the agent runs
  in Docker with a Tailscale sidecar (its own `tailscaled`, joined with an auth key), so
  the host's tailnet membership is untouched.

## Architecture

```
 Discord ──(HTTPS interactions)──▶ Cloudflare Worker  (bot, always on)
                                    ├─ D1: lease, worlds, snapshots, mods, users, enrollments
                                    ├─ R2: world snapshots, mod jars, client zips, archives
                                    ├─ Cron trigger: Mojang version watcher
                                    └─ Tailscale API (OAuth client): mint auth keys, delete devices
                                           ▲  JSON API (agent token) + presigned R2 URLs
                                           │
        Host PC (friend's Windows / maintainer's Fedora) ── mc-host agent
                                    ├─ portable Temurin JDK (version per world)
                                    ├─ Fabric server launcher + server-side mods
                                    └─ on the MC tailnet → players connect to <host>:25565
```

### Components

1. **Worker (`apps/worker`)**
   - Verifies Discord's Ed25519 request signatures. Replies within 3 seconds, or sends a
     deferred response and edits it once the work is done.
   - Posts channel announcements through the Discord REST API using the bot token. There
     is no gateway connection.
   - Exposes an agent API: `lease/claim`, `lease/heartbeat`, `lease/release`,
     `snapshot/upload-url`, `snapshot/commit`, `world/manifest`.
   - Large files never pass through the Worker, because free-tier requests are capped at
     100 MB. Presigned R2 URLs are used instead. Mod `.jar` attachments are small, so the
     Worker fetches them from Discord's CDN and stores them in R2 itself.
2. **D1 schema (conceptual)**
   - `worlds`: id, name, mc_version, fabric_loader, seed, properties (JSON), status (active/archived)
   - `snapshots`: world_id, rev, r2_key, size, sha256, created_at, uploaded_by
   - `mods`: world_id, name, version, side (`server` | `both` | `client-optional`), r2_key, sha256
   - `lease`: a single row holding holder_user_id, host_address, world_id, base_rev, expires_at
   - `users`: discord_id, agent_token_hash, tailscale_device_ids
   - `enrollments`: short-lived codes that are exchanged for agent tokens
3. **Host agent (`apps/agent`, `mc-host`)**
   - `mc-host start` runs these steps in order:
     1. Claim the lease.
     2. Download the manifest and the latest snapshot.
     3. Make sure the right JDK, the Fabric launcher and the mods are present, checking
        each file's sha256.
     4. Launch the server.
     5. Report the host's tailnet address.
   - Heartbeat every 2 minutes. The lease expires after 10 minutes without one.
   - Autosave every 30 minutes: `save-off`, `save-all flush`, zip, upload, commit, `save-on`.
   - `mc-host stop` (or Ctrl+C): graceful `stop`, a final upload, then releases the lease.
4. **Install scripts (`scripts/`)**
   - `install.ps1` (Windows):
     - installs Tailscale with winget (the only step that needs admin)
     - downloads a portable JDK into the app folder
     - downloads `mc-host.exe`
     - runs `tailscale up --auth-key`
     - exchanges the enrollment code for an agent token
   - `install.sh` (Linux) does the same using Docker and a Tailscale sidecar.
   - Both scripts detect what is already installed and skip it.
   - Delivered as a one-liner by `/setup`.
5. **Templates (`profiles/`, committed to the repo)**
   - Default `server.properties`, a baseline list of server-side mods (as Modrinth
     references, not jars), and a recommended client-mod list.
   - Mods and worlds added at runtime live only in R2. The public repo contains no
     binaries and no world data.

### World sync and edge cases

- **Single writer.** A snapshot commit is accepted only from the current lease holder, and
  only if `base_rev` matches the latest rev. Anything else is rejected, so a world can
  never fork.
- **Host crash.** The heartbeat stops and the lease expires. The next host gets the last
  autosave, which loses at most about 30 minutes of play. The bot announces the expiry and
  the time of the last autosave.
- **Crashed host comes back.** The agent finds a local world that is newer than its
  `base_rev`.
  - If no newer snapshot exists in the cloud and the lease is free, it asks whether to
    reclaim the lease and upload.
  - Otherwise it moves the local copy to `recovered/` and never uploads it automatically.
- **Two people try to host at once.** The lease claim is a single conditional D1 update,
  so the loser gets a message saying "X is already hosting at …".
- **Stuck lease.** A maintainer can run `/host release`.
- **Retention.** Keep the last 5 snapshots per active world. When a world is archived,
  keep only its final zip.
- **Integrity.** The agent checks each snapshot's sha256 after downloading and before
  unzipping.

### Discord commands

Every reply is ephemeral (visible only to the requester) unless it is noted as an
announcement.

**Everyone**
- `/help`: a plain-English explanation of each command
- `/status`: who is hosting, the address, the world, the version, lease age
- `/join`: how to connect
- `/setup`: a personal one-line installer containing an enrollment code and a Tailscale auth key
- `/modpack`: link to the client zip (`both` mods plus the recommended client mods)
- `/world download`: link to the latest snapshot

**Maintainers** (Discord role `MC Maintainer`, checked using the member roles included in
the interaction payload)
- `/mod add <jar> <side>`, `/mod remove`, `/mod list`
- `/world new <name> <version> [seed]`, `/world rollback <rev>`, `/world archive`
- `/host release`
- `/tailnet revoke <user>`
- `/watch channel <channel>`

**Announcements**
- hosting started, with the address
- server stopped and the world saved
- lease expired, with the time of the last autosave
- new mod added (players need an updated modpack)
- a new Minecraft release, with a link to the changelog

### Minecraft version handling

- The version list comes from Mojang's `version_manifest_v2.json`.
- Each version's metadata includes a `javaVersion.majorVersion` field. The agent downloads
  the matching Temurin JDK from the Adoptium API. This is why version changes need no
  manual Java setup.
- The Fabric server launcher comes from `meta.fabricmc.net`.
- The watcher cron polls the manifest and announces new entries whose `type` is `release`.
  Snapshots are ignored.

### Error handling

- Every error a user sees is written in plain English and says what to do next, for
  example "Nobody is hosting right now, run `mc-host start` to host."
- Agent failures during start release the lease before the agent exits.
- If an upload fails during autosave, the agent retries with backoff while the server
  keeps running. If uploads keep failing, it warns in the console and in Discord.

### Testing

- **Worker:** unit tests using Vitest with the Cloudflare Workers pool (Miniflare), with
  D1 and R2 emulated. These cover the lease logic (claim races, expiry, stale-commit
  rejection), permission checks, and interaction signature verification.
- **Agent:** unit tests for the sync state machine and crash-recovery decisions, plus an
  integration test against a locally running Worker (`wrangler dev`).
- **Install scripts:** manual checklist on a clean Windows VM and on Fedora.

## Out of scope for v1

A two-way chat bridge, summaries of changelogs by a local language model, `/mod add` by
Modrinth slug, a "preferred host" policy, Headscale, and a web dashboard.
