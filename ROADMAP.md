# Roadmap

Design: [docs/superpowers/specs/2026-09-25-minecraft-discord-bot-design.md](docs/superpowers/specs/2026-09-25-minecraft-discord-bot-design.md)

Phase 0 step-by-step guide: [docs/setup/phase-0.md](docs/setup/phase-0.md)

Friends get onboarded after Phase 4 is done. Phase 5 can be added while they're already playing.

## Phase 0: Setup
- [x] Public repo on GitHub (github.com/alexvtejeda/minecraft-discord-bot)
- [x] Cloudflare account, with R2 enabled
- [x] Discord application and bot, added to the server; create the `MC Maintainer` role
- [x] New Tailscale account for the Minecraft tailnet: apply `infra/tailscale/policy.hujson` (single `tag:mc-player`, port 25565 only), OAuth client with the Auth Keys + Devices Core write scopes

## Phase 1: Server config
Design: [docs/superpowers/specs/2026-09-25-phase-1-profiles-design.md](docs/superpowers/specs/2026-09-25-phase-1-profiles-design.md)
Local test guide: [docs/setup/phase-1.md](docs/setup/phase-1.md)
- [x] Profile schema and lockfile (`packages/profile`), resolved from Modrinth with a `waiting` list
- [x] `vanilla-plus` and `adventure` profiles for 26.3 (`profiles/`)
- [x] Server builder and `.mrpack` builder for Prism Launcher
- [x] Voice chat port (UDP 24454) in the tailnet policy
- [x] Run `adventure` locally on Fedora and join it through Prism

## Phase 2a: Hosting core
Design: [docs/superpowers/specs/2026-09-26-phase-2a-hosting-design.md](docs/superpowers/specs/2026-09-26-phase-2a-hosting-design.md)
- [x] Worker skeleton with D1 and R2 (wrangler), shared `packages/protocol`
- [x] Agent API: lease claim, heartbeat and release; snapshot upload and commit; manifest
- [x] Admin API and `mc-host admin`: world create (with `--import`), token mint, lease release, status
- [x] `mc-host start/stop`: console multiplexer, autosave, heartbeat, crash recovery, Chunky pre-generation
- [x] `install.sh` (Linux, Docker + Tailscale sidecar)
- [x] Deploy, then host the imported `adventure` world from Fedora

## Phase 2b: Java and pack checks
Design: [docs/superpowers/specs/2026-09-26-phase-2b-java-and-packs-design.md](docs/superpowers/specs/2026-09-26-phase-2b-java-and-packs-design.md)
- [x] Managed Temurin JRE on every host, Docker included (`MC_JAVA` overrides it)
- [x] `mc-host profile check-packs`: boot a test server and name the datapacks with errors
- [x] 2a leftovers: autosave rev bump, fresh `--replace` world with Chunky

## Phase 3: Discord commands
Design: [docs/superpowers/specs/2026-09-26-phase-3-discord-design.md](docs/superpowers/specs/2026-09-26-phase-3-discord-design.md)
Setup guide: [docs/setup/phase-3.md](docs/setup/phase-3.md)
- [x] Interactions endpoint and command registration
- [x] `/help`, `/status`, `/join`, `/modpack`, `/world download`, `/mod list`
- [x] Maintainer commands: `/world new|rollback|archive|repin`, `/host release`, with Confirm buttons
- [x] Announcements when a server starts and stops

## Phase 4: Tailnet onboarding (friends onboarded after this phase)
Design: [docs/superpowers/specs/2026-09-26-phase-4-onboarding-design.md](docs/superpowers/specs/2026-09-26-phase-4-onboarding-design.md)
Setup guide: [docs/setup/phase-4.md](docs/setup/phase-4.md)
- [x] `/setup`: enrollment code plus a tagged auth key, as a one-line installer
- [x] `install.ps1` (Windows), plus a release pipeline for prebuilt `mc-host` binaries
- [x] `/tailnet revoke`
- [x] Test on a clean Windows machine, then invite friends

## Local jars
Design: [docs/superpowers/specs/2026-10-03-local-jars-design.md](docs/superpowers/specs/2026-10-03-local-jars-design.md)
Guide: [docs/setup/local-jars.md](docs/setup/local-jars.md)
- [x] `inspectJar`, jar entries in profiles, resolved into the lockfile
- [x] Worker: jars in R2, `GET /jars/<sha512>` for hosts, bundled into the `.mrpack`
- [x] `mc-host admin jar add` and `/mod upload`
- [x] `check-packs` boots mods-only profiles and names missing dependencies
- [ ] Release v0.3.0, deploy, add the CurseForge jars to `cst`

## Phase 5: Lobby
Design: [docs/superpowers/specs/2026-10-03-phase-5-lobby-design.md](docs/superpowers/specs/2026-10-03-phase-5-lobby-design.md)
- [ ] Worker: lobby slot, `lobby`-scoped tokens, lobby backups in R2, lobby in the manifest, `/status` and `/join`
- [ ] `lobby-bridge` Paper plugin: countdown, `/stay`, `/play`, transfer on join
- [ ] `mc-host lobby`: Paper 26.3, restore and backup, polls the Worker, drives the plugin on stdin
- [ ] Hosts: `accepts-transfers=true`, send players back to the lobby on stop
- [ ] `install-lobby.sh`, setup guide; run it on Fedora

## Phase 6: Update watcher
- [ ] Cron job that polls Mojang's version manifest for new releases
- [ ] `/watch channel`, and an announcement with a link to the changelog

## Later
- [ ] Datapacks and resource packs in R2, and the resource pack served by hash (once Vanilla Tweaks ships 26.3 packs)
- [ ] Changelog summaries from a local language model
- [ ] `/mod add` by Modrinth slug
- [ ] Two-way chat bridge between Discord and Minecraft
- [ ] Preferred-host policy
- [ ] Headscale
