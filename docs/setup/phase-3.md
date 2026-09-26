# Phase 3: Discord commands

Design: [../superpowers/specs/2026-09-26-phase-3-discord-design.md](../superpowers/specs/2026-09-26-phase-3-discord-design.md)

## 1. IDs from Discord

Turn on Developer Mode (User Settings → Advanced), then right-click to **Copy ID**:
- the server → `DISCORD_GUILD_ID`
- the announcements channel → `ANNOUNCE_CHANNEL_ID`
- the `MC Maintainer` role (Server Settings → Roles) → `MAINTAINER_ROLE_ID`

From the developer portal (your application → General Information):
- Application ID → `DISCORD_APP_ID`
- Public Key → `DISCORD_PUBLIC_KEY`

Put all five in `apps/worker/wrangler.jsonc` under `vars` and commit them. None of them is a secret.

## 2. Bot token and permissions

Developer portal → Bot → **Reset Token**, then:
```bash
cd apps/worker
bunx wrangler secret put DISCORD_BOT_TOKEN
```
In the announcements channel's settings, give the bot View Channel and Send Messages.

## 3. Deploy and register

```bash
bun run deploy
DISCORD_APP_ID=<id> DISCORD_GUILD_ID=<id> DISCORD_BOT_TOKEN=<token> bun run register
```
`bun run deploy` runs the Worker tests first, so a profile edited without
`mc-host profile resolve` stops the deploy instead of breaking `/world new`.
Register again whenever a command's name, description or options change, or after adding
a profile (the `/world new` profile list is part of the registration).

## 4. Point Discord at the Worker

Developer portal → General Information → **Interactions Endpoint URL**:
`https://mc-bot.<you>.workers.dev/interactions`. Discord sends a test request when you save;
it only saves if the Worker answers it.

## 5. Hide maintainer commands

`/host` is registered hidden from everyone. In Server Settings → Integrations → your bot,
allow the `MC Maintainer` role to use `/host`. `/world` stays visible because
`/world download` is for everyone; its maintainer subcommands answer
"That needs the MC Maintainer role." for anyone else.

## 6. Adding or editing a profile

After editing a profile, run `mc-host profile resolve` so its lockfile matches. To add one,
also add its `profiles/<name>.json` + `.lock.json` imports to `apps/worker/src/profiles.ts`.
Then `bun run deploy` (which runs the tests) and register again.

## Checklist

- [ ] `/help` as a member lists no maintainer commands; as a maintainer it lists them all
- [ ] `/status`, `/join`, `/modpack`, `/mod list`, `/world download` with nobody hosting
- [ ] `mc-host start`: the 🟢 announcement appears; `/status` and `/join` show the address
- [ ] `mc-host stop`: the 🔴 announcement shows the saved rev
- [ ] Import the `/modpack` link in Prism (Add Instance → Import) and join the server
- [ ] `/world rollback` to an older rev, Confirm, then roll forward again
- [ ] `/world repin` says the world already matches
- [ ] `/host release` while hosting from a second terminal: Confirm, and the announcement appears
- [ ] `/world new test-world vanilla-plus` → preview → Cancel changes nothing
- [ ] A member without the role running `/world rollback` gets "That needs the MC Maintainer role."
