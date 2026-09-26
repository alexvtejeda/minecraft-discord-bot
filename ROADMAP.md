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
- [ ] Interactions endpoint and command registration
- [ ] `/help`, `/status`, `/join`, `/modpack`, `/world download`, `/mod list`
- [ ] Maintainer commands: `/world new|rollback|archive|repin`, `/host release`, with Confirm buttons
- [ ] Announcements when a server starts and stops

## Phase 4: Tailnet onboarding (friends onboarded after this phase)
- [ ] `/setup`: enrollment code plus a tagged auth key, as a one-line installer
- [ ] `install.ps1` (Windows), plus a release pipeline for prebuilt `mc-host` binaries
- [ ] `/tailnet revoke`
- [ ] Test on a clean Windows machine, then invite friends

## Phase 5: Proxy lobby (new feature, needs brainstorming)
- [ ] A process that runs 24/7 with a fixed minecraft superflat world I can customize with [MoveMeNow](https://www.spigotmc.org/resources/movemenow.17/) plugin
- [ ] Should be shown when there is no host running the server
- [ ] Once a host is running  the real world, the user should be auto-redirected, we can use the AutoReconnect plugin

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
