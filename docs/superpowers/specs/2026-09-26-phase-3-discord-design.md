# Phase 3: Discord commands — Design

Date: 2026-09-26
Status: Approved design
Parent design: [2026-09-25-minecraft-discord-bot-design.md](2026-09-25-minecraft-discord-bot-design.md)
Previous phase: [2026-09-26-phase-2b-java-and-packs-design.md](2026-09-26-phase-2b-java-and-packs-design.md)

## Goal

Everything a player or maintainer does day to day happens through Discord slash commands
on the existing Worker: checking who is hosting, getting the modpack, downloading the
world, creating, rolling back and archiving worlds, re-pinning mods and releasing a stuck
lease. The bot also posts announcements when a server starts and stops. `/setup` and
tailnet onboarding stay in Phase 4.

## Changes from the parent design

| Parent design | Phase 3 | Why |
|---|---|---|
| `/mod add <jar> <side>`, `/mod remove` | Dropped. `/mod list` shows the pinned lockfile, and `/world repin` re-pins the active world to the lockfile in the current deploy. | Mods come from profiles and lockfiles since Phase 1. Jars that exist only in R2 stay in Later. |
| `/world new <name> <version> [seed]` | `/world new <name> <profile> [seed]` | Worlds are created from a profile, which pins the version. |
| Announcements: started, stopped, lease expired, mod added | Started and stopped only | Lease expiry would need a cron. `/status` shows nobody hosting once a lease has expired. |
| `/watch channel` | Phase 6 | Announcements use a fixed channel from `wrangler.jsonc`. |

## Refinements from planning

- **`/world` stays visible to everyone.** `/world download` is for players, and Discord hides
  commands per top-level name, so only `/host` is registered hidden. The `/world` maintainer
  subcommands are refused server-side.
- **No deferred replies.** `/modpack` returns a URL and the Worker builds the pack on its own
  route, so every command answers within Discord's 3 seconds. `respond.ts` has no deferral
  helper and `rest.ts` only posts channel messages.
- **Tests spy on `fetch` with `vi.spyOn`.** The installed `@cloudflare/vitest-plugin` (1.2.8)
  has no `fetchMock`.
- The modpack route lives in `routes/modpack.ts`, and the builder in `src/mrpack.ts`.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Discord layer | Hand-rolled on the existing Hono app, typed with `discord-api-types` | About a dozen commands. WebCrypto verifies Ed25519 natively, so no framework is needed. |
| Command source of truth | One registry. The router dispatches from it, and `register-commands.ts` registers from it. | The commands that run and the commands registered can't drift apart. |
| Registration | Guild-scoped, bulk overwrite | Updates are instant and the commands stay in the one server. |
| Handlers | Call `lease.ts`, `worlds.ts` and `snapshots.ts` directly | The admin HTTP routes stay for `mc-host admin`, and both share the same logic. |
| Profiles on the Worker | `profiles/*.json` and `*.lock.json` are bundled at build time | No network dependency at runtime, and a half-edited profile can't be picked up. Changing a profile means a redeploy. |
| Destructive commands | An ephemeral preview with Confirm and Cancel buttons | Shows what's about to happen. The pending action lives in `custom_id`, so nothing is stored. |
| Rollback | Adds a new rev that points at the old rev's R2 object | Nothing is lost, and a rollback can be undone. |
| Announcement channel and maintainer role | `ANNOUNCE_CHANNEL_ID` and `MAINTAINER_ROLE_ID` vars in `wrangler.jsonc` | Simple. Changing them means a redeploy. |
| `/modpack` delivery | A stable, unauthenticated `GET /modpack/<world-id>.mrpack`, built on request from the pinned lockfile with `packages/profile`'s `.mrpack` builder | Prism can import straight from the URL. The pack only contains Modrinth links, and the repo is public. |
| Slow replies | A deferred ephemeral reply, finished in `ctx.waitUntil` by editing the original response | Discord's 3-second deadline only applies to the first reply. |

## Components

```
apps/worker/src/
  discord/
    verify.ts        Ed25519 check of X-Signature-Ed25519 + X-Signature-Timestamp (WebCrypto)
    respond.ts       reply builders: ephemeral message, deferred, update-message (buttons)
    rest.ts          bot-token REST: post a channel message, edit the original interaction response
    router.ts        POST /interactions: verify → PING → dispatch a slash command, autocomplete or button
    registry.ts      the list of commands: definition, maintainerOnly flag, handler
    confirm.ts       Confirm/Cancel buttons; builds and parses custom_id "confirm:<action>:<args>"
  commands/
    help.ts status.ts join.ts modpack.ts world.ts mod.ts host.ts
  announce.ts        started/stopped posts
  modpack.ts         .mrpack for a world, from its pinned lockfile
  profiles.ts        the bundled profiles and lockfiles
  routes/public.ts   GET /modpack/<world-id>.mrpack
apps/worker/scripts/register-commands.ts   PUT /applications/<app id>/guilds/<guild id>/commands
docs/setup/phase-3.md                       setup steps and manual checklist
```

The Worker gains a dependency on `packages/profile` (the lockfile types and the `.mrpack`
builder, which uses only WebCrypto and fflate).

### Configuration

| Name | Kind | Value |
|---|---|---|
| `DISCORD_APP_ID` | var | Application ID |
| `DISCORD_PUBLIC_KEY` | var | Public key from the developer portal |
| `DISCORD_GUILD_ID` | var | The Discord server's ID |
| `ANNOUNCE_CHANNEL_ID` | var | Channel for announcements |
| `MAINTAINER_ROLE_ID` | var | ID of the `MC Maintainer` role |
| `DISCORD_BOT_TOKEN` | secret | Used for channel posts, message edits and registration |

The bot needs View Channel and Send Messages in the announcement channel.

## Commands

Every reply is ephemeral. 🔒 means maintainer only. ✅ means the command uses Confirm and Cancel.

| Command | Behaviour |
|---|---|
| `/help` | A plain-English line for each command. Maintainer commands are listed only if the user has the role. |
| `/status` | Hosting: the host (@mention), the address `<ip>:25565`, the world, the MC version, how long they've been hosting, the latest rev and when it was saved. Not hosting: "Nobody is hosting. Last saved 3h ago by Alex." No active world: says so and points to `/world new`. |
| `/join` | Step-by-step: install Prism, import the `/modpack` URL, connect to the current address. When every mod in the profile is `server` or `client-optional`, it says any vanilla client of that version works and the modpack is optional. Until Phase 4, it ends with "ask a maintainer to get you onto the tailnet". |
| `/modpack` | The `.mrpack` URL for the active world, plus a one-line Prism import tip. |
| `/world download` | A 1-hour presigned link to the active world's latest snapshot, with its size and rev. |
| `/mod list` | The pinned lockfile grouped by side (server, both, client-optional), with versions, plus the `waiting` list. |
| 🔒 `/world new <name> <profile> [seed]` | `profile` is a choice list of the bundled profiles. Refused while someone is hosting. If a world is active, ✅ previews "archives *adventure* (rev 14), starts *spring* on 26.3". Uses `createWorld` with `replace`. |
| 🔒 `/world rollback <rev>` | `rev` autocompletes from the kept snapshots ("rev 7 — 3h ago by Alex"). ✅. The lease must be free. |
| 🔒 `/world archive` | ✅. The lease must be free. Archives the active world, leaving none active. |
| 🔒 `/world repin` | ✅ previews a mod diff against the bundled lockfile for the world's profile (+ added, − removed, ~ version changed). Refused if the lockfile's MC version differs from the world's, since that needs a new world. The lease must be free. The next `mc-host start` builds from the new lockfile. |
| 🔒 `/host release` | ✅ previews "Alex has been hosting for 2h, last heartbeat 40s ago". Force-releases the lease. |

### Maintainer check

- The router checks `member.roles` in the interaction payload against `MAINTAINER_ROLE_ID`.
  This happens for the slash command and again when Confirm is pressed.
- Maintainer commands are also registered with `default_member_permissions: "0"`, so they
  are hidden from non-maintainers until an admin grants the role access in the server's
  Integrations settings. The server-side check is what actually enforces access.
- Non-maintainers get "That needs the MC Maintainer role."

### Confirm flow

1. The slash command replies with an ephemeral preview and two buttons. Confirm's
   `custom_id` is `confirm:<action>:<args>`, for example `confirm:rollback:<worldId>:7`.
   Cancel's is `cancel`.
2. On Confirm, the handler re-checks the role and the state: the same world is active, the
   lease is free where required, and the rev still exists. If anything changed, it replies
   "Things changed since the preview. Run the command again."
3. Cancel and the result both replace the preview (an update-message response) and remove
   the buttons, so a preview can't be confirmed twice.

### Rollback and retention

- A rollback inserts rev `latest + 1` with the target rev's `r2_key`, `size` and `sha256`,
  and `uploaded_by` set to `rollback:<discord id>`. The world's lockfile doesn't change.
- `pruneWorld` still keeps the newest 5 rows. It deletes an R2 object only when no
  surviving row references its key.
- The kept revs are the only rollback targets.

### Archive

`/world archive` marks the world archived and prunes it down to its latest snapshot. With
no active world, `/status`, `/join`, `/modpack` and `/world download` say so and point to
`/world new`.

## Announcements

These are posted to `ANNOUNCE_CHANNEL_ID` from `ctx.waitUntil`, so the request that
triggered them never waits on Discord or fails because of it. A failed post is logged
and not retried.

| Event | Where it's hooked | Message |
|---|---|---|
| Lease claimed (including a recovery reclaim) | `POST /agent/lease/claim`, on success | "🟢 @Alex is hosting **adventure** (26.3) at `100.x.y.z:25565`. `/join` for how to connect." |
| Graceful stop | `POST /agent/lease/release`, on success | "🔴 @Alex stopped the server. World saved as rev 15." |
| Maintainer release | the `/host release` confirm | "🔴 A maintainer released Alex's hosting session. Last save: rev 14, 25 min ago." |

- `allowed_mentions` lists only the host's user ID.
- Heartbeats, autosaves and lease expiry are never announced.
- The `mc-host admin` release route does not announce. Only the Discord command does.

## Error handling

- Handlers throw the existing `ApiError`s. The router turns them into an ephemeral reply
  with the same plain-English message, which already says what to do next.
- Anything unexpected gets "Something went wrong on my end, try again in a minute." plus a
  `console.error` with the interaction ID, visible in `wrangler tail`.
- A missing or invalid signature gets a 401. Discord probes this when the endpoint URL is
  saved.
- If a deferred reply's follow-up edit fails, the error is logged. The user sees Discord's
  "The application did not respond" message.

## Testing

Vitest with the Cloudflare Workers pool (Miniflare), as in Phase 2a.

- **Signing:** the tests generate an Ed25519 key pair and use its public key as
  `DISCORD_PUBLIC_KEY`. A helper signs every test interaction. `verify.ts` is covered for a
  valid signature, a tampered body, a tampered timestamp, and PING.
- **Commands:** one test file per command group. Each covers the reply content, the
  maintainer denial, and the refusals when the lease is held or no world is active.
- **Confirm flow:** preview then confirm acts; a stale preview is refused; a non-maintainer
  clicking Confirm is refused; Cancel leaves the state unchanged.
- **Rollback and retention:** a rollback row shares an R2 object with the original, and
  pruning the original row keeps the object. Rolling back a rollback works.
- **Repin:** the mod diff, and the refusal on a different MC version.
- **`.mrpack`:** the index contents match the lockfile, optional mods are marked optional,
  and the same lockfile always produces the same bytes.
- **Announcements:** Discord REST is mocked with `fetchMock`. The tests check the posts on
  claim and release, and that a failing post still returns 200 to the agent.
- **Registration:** a unit test checks that the registry serializes to valid command JSON
  (names, option types, `default_member_permissions`). The script itself is run by hand.

### Manual checklist (`docs/setup/phase-3.md`)

1. Set the vars and the bot token secret, then deploy.
2. Run `register-commands.ts`.
3. Paste `https://<worker>/interactions` into the developer portal's Interactions Endpoint URL.
4. Run every command as a maintainer and as a regular member.
5. Run `mc-host start` and `mc-host stop` for real and check both announcements.
6. Import the `/modpack` URL into Prism and join.

## Out of scope

`/setup` and `/tailnet revoke` (Phase 4), `/watch channel` (Phase 6), `/mod add` with
uploaded jars, downloads of archived worlds from Discord, and a lease-expiry announcement.
