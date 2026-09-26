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

## Phase 2: Hosting
- [ ] Worker skeleton with D1 and R2 (wrangler)
- [ ] Agent API: lease claim, heartbeat and release; snapshot upload and commit; manifest
- [ ] `mc-host` agent: start/stop, autosave, heartbeat, crash recovery
- [ ] Portable JDK chosen per Minecraft version
- [ ] `install.ps1` (Windows) and `install.sh` (Linux, Docker + Tailscale sidecar)
- [ ] `build-server` checks each datapack's `pack_format` against the Minecraft version and names the ones that would stop the server from starting

## Phase 3: Discord commands
- [ ] Interactions endpoint and command registration
- [ ] `/help`, `/status`, `/join`, `/modpack`, `/world download`
- [ ] Maintainer commands: `/mod …`, `/world new|rollback|archive`, `/host release`
- [ ] Announcements

## Phase 4: Tailnet onboarding (friends onboarded after this phase)
- [ ] `/setup`: enrollment code plus a tagged auth key, as a one-line installer
- [ ] `/tailnet revoke`
- [ ] Test on a clean Windows machine, then invite friends

## Phase 5: Update watcher
- [ ] Cron job that polls Mojang's version manifest for new releases
- [ ] `/watch channel`, and an announcement with a link to the changelog

## Later
- [ ] Changelog summaries from a local language model
- [ ] `/mod add` by Modrinth slug
- [ ] Two-way chat bridge between Discord and Minecraft
- [ ] Preferred-host policy
- [ ] Headscale
