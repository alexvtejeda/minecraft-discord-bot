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
bun run register   # reads DISCORD_APP_ID, DISCORD_GUILD_ID, DISCORD_BOT_TOKEN from the repo's .env
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

## 5. If Avast cuts off the setup line

Avast's Web Shield can stop `irm … | iex` with "The connection was closed unexpectedly", or
flag the Tailscale download. Pause it (Protection → Core Shields → Web Shield → 10 minutes),
paste the line again (it isn't used up by a failed download), then turn the shield back on.
`/setup help` tells friends the same.

## 6. If Windows Defender blocks mc-host.exe

Unsigned programs built with Bun are sometimes flagged. If it happens: Windows Security →
Virus & threat protection → Protection history → Allow, or add
`%LOCALAPPDATA%\mc-host\bin` under Exclusions.

## Checklist (clean Windows 10/11 VM)

- [ ] `/setup play` → paste the line → one permission prompt → "You're on the Minecraft network"
- [ ] The device shows up in the Tailscale admin tagged `tag:mc-player`, named `mc-<username>`
- [ ] Host from Fedora; the VM joins through Prism (import the `/modpack` link)
- [ ] Running the same line again says the link expired
- [ ] `/setup host` on the same VM: no Tailscale install, no network key minted; `mc-host.exe`, the **Host Minecraft** shortcut and the two `Minecraft (mc-host)` firewall rules appear; `mc-host status` prints
- [ ] `mc-host --version` in a new terminal prints `mc-host 0.2.0` (PATH works)
- [ ] Host from the shortcut: the JRE downloads and extracts, the 🟢 announcement shows a `100.x` address, and Fedora joins
- [ ] If Windows asks about Java's network access, note what it asked (it shouldn't, thanks to the port rules)
- [ ] Ctrl+C: the world saves and uploads, and the 🔴 announcement shows the new rev
- [ ] Download that rev on Fedora (`/world download`) and host it there: the world opens with everything intact (Windows → Linux zip paths)
- [ ] Host from the shortcut again, close the window mid-session; the next start offers to upload the local world
- [ ] `/tailnet revoke` the VM's user: the device disappears from the admin, `mc-host start` is refused, and `/setup` says they were removed
- [ ] `mc-host admin token mint` lets them back in, and `/setup` works again
- [ ] Invite friends
