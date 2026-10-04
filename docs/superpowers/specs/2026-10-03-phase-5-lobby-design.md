# Phase 5: Lobby — Design

Date: 2026-10-03
Status: Approved design, not yet planned
Parent design: [2026-09-25-minecraft-discord-bot-design.md](2026-09-25-minecraft-discord-bot-design.md)
Related: [2026-09-26-phase-2a-hosting-design.md](2026-09-26-phase-2a-hosting-design.md), [2026-09-26-phase-3-discord-design.md](2026-09-26-phase-3-discord-design.md)

## Goal

Give friends one server address that never changes and always answers. When nobody is
hosting, it is a Paper hangout world the maintainer customizes with plugins (or a
downloaded hub map). When someone is hosting, the lobby sends players to the host's
server. Hosting keeps working exactly as today when the lobby is down: the lobby is a
layer in front, never a dependency.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Shape | A lobby server that hands players off with the vanilla `/transfer` command (1.20.5+). No Velocity or BungeeCord proxy. | The client logs in fresh to the host, so Fabric registry sync, Simple Voice Chat and performance are exactly as today. A proxy would need FabricProxy-Lite and a forwarding secret on every host, and switching a connected client from a vanilla lobby to a modded backend is fragile. |
| Always-on machine | Accepted for the lobby only. Runs on the maintainer's Fedora box, later a Raspberry Pi. | Something has to answer TCP when nobody hosts, and Workers can't. Since the lobby carries no game traffic, it can be weak hardware and its outages never interrupt a game. |
| Server software | Paper 26.3 | Plugin ecosystem for a hangout (WorldEdit, holograms, NPCs). ViaVersion is the fallback if Paper lags a future Minecraft release. |
| Process | `mc-host lobby`, a new subcommand of the existing agent | Reuses the managed JRE, zip/upload, console multiplexer and the Docker plus Tailscale sidecar setup. The Pi only adds a `linux-arm64` build target. |
| Redirect logic | A small Java Paper plugin, `lobby-bridge`, in the repo. `mc-host lobby` polls the Worker and tells the plugin the state over RCON. | `/stay`, `/play` and transfer on join must hook into in-game events. Keeping the Worker token and HTTP code in TypeScript keeps the plugin free of secrets and API knowledge. |
| Existing lobby players when a host comes up | 10 s countdown in chat, then transfer everyone who didn't type `/stay` | Matches "auto-redirect" without yanking someone mid-build. |
| Players joining while a host is up | Transferred one second after joining | They came to play; the lobby is just the doorway. |
| Persistence | The whole lobby folder (world, plugins, configs) is zipped to R2, every 30 min and on stop. Keep the last 3. Restored on a machine with no local folder. | Makes the Pi move a non-event and survives SD card failure. Plugins are part of the backup; there is no plugin manifest. |
| Single writer | A lobby slot: a one-row lease with a heartbeat, separate from the host lease | Stops two lobbies (Fedora and Pi during the move) from overwriting each other's backups. |
| Credentials | A token with scope `lobby`, minted with `mc-host admin token mint --lobby` | It can hold the lobby slot, read the host lease and back up the lobby, but cannot claim a host lease or commit a world snapshot. |
| Crashed host | Players reconnect to `mc-lobby` by hand | Only a proxy could catch that disconnect. Rare enough not to matter. |
| Lobby start/stop announcements | None | The lobby restarts often; it would be noise. |
| Downloaded hub maps | Allowed, never committed | The repo is public and most map licences forbid redistribution. They live in the lobby folder and its R2 backups. |

## Architecture

```
 Fedora box (later: Pi)
 └─ Docker project "mc-lobby": lobby container + Tailscale sidecar → tailnet name "mc-lobby"
     └─ mc-host lobby                 (TypeScript)
         ├─ claims the lobby slot, heartbeats
         ├─ restores the lobby folder from R2 if missing; backs it up every 30 min and on stop
         ├─ runs Paper 26.3 with the managed JRE
         ├─ polls the Worker every 5 s for the host lease
         └─ on change: RCON "lobbybridge host …" / "lobbybridge none" ──▶ lobby-bridge plugin (Java)
                                                                          ├─ countdown, /stay, /play
                                                                          └─ transfer on join
 Host PC ── mc-host start
     ├─ writes accepts-transfers=true to server.properties
     └─ on stop: transfer @a to the lobby (if it's up), then the normal save, upload, release
```

## Components

### `mc-host lobby` (apps/agent)

1. **Claim** the lobby slot with the sidecar's `100.x` address. If another machine holds
   it: "The lobby is already running on <hostname> (heartbeat 1m ago). Stop it there
   first, or run `mc-host admin lobby release`."
2. **Restore.** If the lobby folder doesn't exist locally, download the latest backup and
   check its sha256 before unzipping. If there is no backup, create a fresh lobby: Paper
   26.3, superflat `server.properties`, `lobby-bridge`. If the backup is corrupt or the
   download fails, refuse to start; `--fresh` overrides. A fresh empty lobby must never
   silently replace a build.
3. **Plugin.** Make sure `plugins/lobby-bridge.jar` is the version this `mc-host` ships
   (download it from the GitHub release, check its sha256). Never touch other plugins.
4. **Paper.** Download the pinned Paper build (sha256 checked), start it with RCON bound
   to `127.0.0.1` and a random password generated each start. Same console multiplexer as
   hosting, so the maintainer can type commands.
5. **Poll.** Every 5 s, `GET /lobby/state` returns the host lease (holder name, address,
   world name, MC version) or null. The poll doubles as the slot heartbeat. When the
   result changes, send `lobbybridge host <address> <port> <holder> <world>` or
   `lobbybridge none` over RCON. Also re-send after Paper restarts. If the Worker is
   unreachable, keep the last state, retry with backoff, log once.
6. **Backup.** Every 30 min and on stop: `save-off`, `save-all flush`, zip the folder
   (excluding `cache/`, `libraries/`, `versions/`, `logs/` and the Paper jar), upload by
   presigned URL, commit, `save-on`. Reuses the host snapshot code. On repeated failure,
   warn in the console; the lobby keeps running.
7. **Stop** (Ctrl+C or Docker stop): Paper `stop`, final backup, release the slot.

### `lobby-bridge` (new `apps/lobby-bridge`, Java, Gradle)

State: `none` or `host(address, port, holder, world)`, set only by the `lobbybridge`
console command (op/console only).

| Situation | Behaviour |
|---|---|
| State goes `none` → `host` | Broadcast "🟢 <holder> is hosting **<world>**. Sending you there in 10s. `/stay` to remain." Countdown in the action bar. At 0, transfer every online player who didn't `/stay`. |
| A player joins while `host` | Title "Sending you to <holder>'s server…", transfer one second later. |
| `/stay` during a countdown or while `host` | Cancels that player's transfer until they type `/play` or the state goes back to `none`. |
| `/play` | Transfer now if `host`; otherwise "Nobody's hosting right now. Run `mc-host start` to host." |
| State goes `host` → `none` mid-countdown | Cancel the countdown, broadcast "Hosting stopped." Clear all `/stay` flags. |
| A player joins while `none` | Join message: "Nobody's hosting. `/status` in Discord shows who hosted last." |

Transfer uses Paper's `Player#transfer(host, port)`. Built and attached to the GitHub
release by the same pipeline as `mc-host` binaries; its version and sha256 are compiled
into `mc-host`.

### Worker (apps/worker)

- **D1 migration**
  - `users.scope` (`host` default, or `lobby`). Lobby-scoped tokens are refused on every
    `/agent/*` route; host tokens are refused on `/lobby/*`.
  - `lobby_slot`: one row, `holder_hostname`, `address`, `session_id`, `expires_at`.
    Expires after 2 minutes without a poll.
  - `lobby_backups`: `rev`, `r2_key`, `size`, `sha256`, `created_at`. Keep 3.
- **Lobby API** (lobby token): `POST /lobby/claim`, `GET /lobby/state` (also heartbeats),
  `POST /lobby/release`, `POST /lobby/backup/upload-url`, `POST /lobby/backup/commit`,
  `GET /lobby/backup/latest`. Backup commit needs the current slot session, the same
  single-writer rule as world snapshots.
- **Admin:** `mc-host admin token mint --lobby <name>` and `mc-host admin lobby release`.
- **Agent manifest:** add `lobby: { address } | null` (null when the slot is expired) so
  `mc-host stop` knows where to send people.
- **Discord**
  - `/join`: "Add `mc-lobby` as your server, once." Full `mc-lobby.<tailnet>.ts.net`
    as a fallback if the short name doesn't resolve. Suggests a second entry for direct
    connections when the lobby is down.
  - `/status`: a lobby line (🟢 up / ⚫ down). When the lobby is down and someone is
    hosting: "Lobby is down, connect directly to `100.x.y.z:25565`."
  - The 🟢 hosting announcement keeps the direct address.

### Hosting changes (apps/agent)

- `mc-host start` adds `accepts-transfers=true` to the `server.properties` overrides.
- `mc-host stop`: if the manifest names a lobby, run `transfer @a <lobby> 25565`, wait
  2 s, then the normal stop. If there is no lobby or the lookup fails, skip it silently.

### Infra

- `infra/docker/lobby-compose.yml`: project `mc-lobby`, a Tailscale sidecar with
  `TS_HOSTNAME=mc-lobby` and a `tag:mc-player` auth key, the agent container running
  `mc-host lobby`, `restart: unless-stopped`. No change to the tailnet policy: the lobby is
  a `tag:mc-player` device on port 25565 and clients already reach those.
- `scripts/install.sh --lobby` sets it up. Docker images and the release build add
  `linux-arm64` for the Pi.
- A setup guide, `docs/setup/phase-5.md`, covering the token, the install, dropping in a
  downloaded map, and the Pi move.

## Error handling

| Failure | Behaviour |
|---|---|
| Lobby slot held elsewhere | Refuse to start, name the holder and the heartbeat age, point to `mc-host admin lobby release`. |
| Worker unreachable while polling | Keep the last state, back off, log once. The hangout keeps working. |
| Backup upload fails | Retry with backoff, warn in the console. |
| Restore fails or sha256 mismatch | Refuse to start. `--fresh` creates an empty lobby on purpose. |
| Transfer target unreachable | The client shows its own error. Reconnecting to `mc-lobby` lands them back in the lobby. |
| Paper crashes | `mc-host lobby` exits with the log tail. Docker restarts it. |
| Lobby down when a host stops | The send-back is skipped and the stop proceeds normally. |

## Testing

- **Worker (Vitest, Miniflare):** lobby slot claim, heartbeat, expiry and a refused second
  claimant; token scopes in both directions; backup commit only from the slot holder;
  rotation to 3; `lobby` in the manifest; `/status` and `/join` text for lobby up/down.
- **Agent:** poll loop sends RCON only on change and after a Paper restart; backup
  exclusions and rotation; restore refuses corrupt backups; `stop` sends players back
  only when a lobby is named. Integration test against the local Worker with Paper faked,
  like the existing host integration test.
- **Plugin (MockBukkit):** countdown, `/stay`, `/play`, transfer on join, cancellation
  when the host goes away.
- **Manual checklist:**
  - Lobby on Fedora, host on the Windows VM: join `mc-lobby`, the host comes up, countdown, transfer.
  - `/stay` keeps you in; `/play` sends you.
  - Joining while a host is up transfers within a second.
  - `mc-host stop` on the host sends everyone back to the lobby.
  - Stop the lobby: hosting still works, `/status` shows the direct address.
  - Delete the local lobby folder and start again: it restores from R2 (stand-in for the Pi move).
  - Drop a downloaded hub map in as the world; it survives a backup and restore.

## Out of scope

A real proxy, catching crashed-host disconnects, lobby announcements in Discord, a
plugin manifest for the lobby, running more than one lobby, and minigames in the
plugin itself (use existing Paper plugins for that).
