# Phase 4: Tailnet onboarding — Design

Date: 2026-09-26
Status: Approved design
Parent design: [2026-09-25-minecraft-discord-bot-design.md](2026-09-25-minecraft-discord-bot-design.md)
Previous phase: [2026-09-26-phase-3-discord-design.md](2026-09-26-phase-3-discord-design.md)

## Goal

A friend on a clean Windows PC runs `/setup` in Discord, pastes one line into PowerShell,
clicks Yes once, and is on the Minecraft tailnet. `/setup host` also installs `mc-host.exe`
and a **Host Minecraft** Start Menu shortcut. A maintainer can take anyone off the tailnet
with `/tailnet revoke`. Prebuilt `mc-host` binaries come from GitHub Releases. Friends are
invited once the rollout checklist passes.

## Changes from the parent design

| Parent design | Phase 4 | Why |
|---|---|---|
| One installer that sets up everything for everyone | `/setup` joins the tailnet (play). `/setup host` also installs `mc-host` and mints a hosting token. Anyone can run either. | Most friends only play. They don't need the agent or the JRE. |
| `install.ps1` downloads a portable JDK | It doesn't. `mc-host start` downloads the managed JRE (Phase 2b). | Already solved in the agent. |
| `install.ps1` and `install.sh` | Windows only. `install.sh` is unchanged and still builds from the checkout. | Every friend is on Windows, and only the maintainer hosts from Linux. |
| `users.tailscale_device_ids` | A `devices` table | One row per device. The installer reports the node ID. |
| The installer "detects what is already installed" | It also stops if Tailscale is logged in to a different tailnet | Assume clean PCs, and never touch someone's other tailnet. |

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Secret delivery | An enrollment code, redeemed by the installer. The auth key and token are minted only on redemption. | Nothing that grants access sits in Discord, and the Worker learns the node ID so revokes are precise. |
| Script delivery | The Worker serves `install.ps1` at `/s/<code>`, with the Worker URL and code filled in | A short one-liner (`irm … \| iex`), and the script always matches the deployed Worker. |
| Auth key | Single-use, pre-authorized, `tag:mc-player`, expires in 10 minutes | Minted just before `tailscale up`. |
| Code | 8 characters from an unambiguous alphabet (`K7QX-P2MD`), stored hashed, single-use, expires in 15 minutes. A new `/setup` replaces the user's unused code. | Long enough to type, and useless once spent. |
| Binaries | A GitHub Actions release on `v*` tags: `mc-host-windows-x64.exe`, `mc-host-linux-x64`, `SHA256SUMS` | Friends don't need Bun or the repo. |
| Old agents | `X-MC-Agent-Version` on every agent request. Below `MIN_AGENT_VERSION` the Worker answers 426 "Run `/setup host` to update." | Friends won't update on their own, so after an API change they get a clear message instead of a confusing error. |
| Updating `mc-host` | Run `/setup host` again (rotates the token, installs the latest release) | No self-update (YAGNI). |
| Closing the hosting window | Treated as a stop signal, best effort. Recovery is handled by existing crash recovery. | Windows kills a closed console after about 5 seconds, which isn't enough to upload. |

## Worker

### Schema (`0002_onboarding.sql`)

```sql
CREATE TABLE enrollments (
  discord_id TEXT PRIMARY KEY,       -- one pending code per user
  name TEXT NOT NULL,                -- Discord username, for the hostname and the users row
  code_hash TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('play', 'host')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,                   -- set on redemption; /enroll/device accepts it for 15 minutes after
  reported_at INTEGER                -- set by the one device report each redemption gets
);

CREATE TABLE devices (
  node_id TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

`users` is reused for everyone who enrolls. A `play` redemption creates the user row with
the hash of a random token that is never returned, so `revoked_at` works the same way for
players and hosts. A `host` redemption calls the existing `mintToken`, which also rotates
an existing token.

### Routes and commands

**`/setup [host]`** (everyone, ephemeral)
- A user with `revoked_at` set gets "You've been removed from the Minecraft network. Ask a
  maintainer to let you back in." A maintainer re-enables them by running
  `mc-host admin token mint`, which already clears `revoked_at`.
- Otherwise it upserts the user's `enrollments` row and replies with:
  1. Open PowerShell (Start → type "PowerShell").
  2. Paste `irm https://<worker>/s/K7QX-P2MD | iex` and press Enter.
  3. Click Yes when Windows asks for permission.
  It also notes that the line is personal, works once, and expires in 15 minutes.

**`GET /s/<code>`**
- Serves `scripts/install.ps1`, which is bundled into the Worker as text, with
  `$WorkerUrl`, `$Code` and `$Mode` filled in, so the admin step knows before redeeming
  whether to add the firewall rule. It does not consume the code.
- An unknown, used or expired code gets a short script that prints "This setup link
  expired. Run /setup in Discord again." and exits.

**`POST /enroll { code, join }`**
1. Look up an unused, unexpired code. If there isn't one, return 410 with the expired message.
2. If `join`, mint the Tailscale auth key. If that fails, return 502. The code is **not** consumed,
   and the Worker logs Tailscale's response.
3. Consume the code with a conditional update (`used_at IS NULL`). If that loses a race,
   return 410. The minted key is wasted, but it's single-use and expires in 10 minutes.
4. In host mode, mint the token.
5. Return `{ authKey?, hostname, token? }`. The hostname is `mc-<discord name>`: lowercased,
   `[a-z0-9-]` only, at most 40 characters.

**`POST /enroll/device { code, nodeId }`**
- Accepted once per redemption (`reported_at`), and only when the code's `used_at` is
  within the last 15 minutes.
- Revoke deletes what's recorded here, so the node must be tagged `tag:mc-player`
  (checked with Tailscale's `GET /device/{id}`) and must not already be on record for
  someone else. Otherwise it answers 409. The installer carries on without the report
  and tells the user to let a maintainer know.

**`/tailnet revoke <user>`** (maintainer, with a Confirm button, registered hidden like `/host`)
1. Set `users.revoked_at`, so their hosting token stops working, and delete their pending
   enrollment. This happens first, so the person is blocked even if Tailscale fails.
2. Delete each of the user's devices through the Tailscale API (a 404 counts as success),
   and its `devices` row. If Tailscale fails partway, running the command again finishes the job.

If they're hosting, the reply says their lease expires within 10 minutes, as after a crash.

### Tailscale client (`src/tailscale.ts`)

- `mintAuthKey(env, description)` and `deleteDevice(env, nodeId)`. They use the global `fetch`,
  which tests replace with `vi.spyOn`, as in Phase 3.
- It exchanges `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` (new Worker secrets, from the
  OAuth client created in Phase 0) for an access token on each call. Traffic is a handful
  of calls a week.
- Exact endpoints and the auth key request body are confirmed against Tailscale's API docs
  during planning.

### Agent version check

- The agent sends `X-MC-Agent-Version`, read from `apps/agent/package.json` at build time.
- The Worker compares it with `MIN_AGENT_VERSION` (a `vars` entry). An older version, or a
  missing header, gets 426: "mc-host is out of date. Run `/setup host` in Discord to update."
- `mc-host --version` prints the version.
- Agents of 0.1.0 and older don't know the new error codes, so they see "answered HTTP 426"
  instead of the update message. Only the maintainer's Linux install is affected; re-run
  `scripts/install.sh`.

## `install.ps1`

Targets Windows PowerShell 5.1. It stays thin and straight-line, and every step is safe to re-run.

1. **Preflight.** It needs Windows 10 or 11 on x64. If Tailscale is installed and logged in
   to a different tailnet, it stops, explains, and changes nothing. If it's already on the
   Minecraft tailnet, it skips the Tailscale install (step 2) and the join (step 4).
2. **Admin step, with one UAC prompt,** only when there's something to do. An elevated PowerShell:
   - installs Tailscale from the official MSI, downloaded before the prompt. The MSI works
     on every Windows 10/11 and needs no winget;
   - host mode only: adds an inbound firewall rule for TCP 25565 and UDP 24454 from
     `100.64.0.0/10` only. Windows puts the Tailscale adapter on the Public profile, so
     without the rule players can't reach the server.
3. **Redeem** with `POST /enroll { code, join }`. `join` is false when the PC is already on
   the tailnet, so no auth key is minted. This happens after the install, so the 10-minute
   key doesn't expire while winget runs.
4. **Join** with `tailscale up --auth-key=… --hostname=<hostname>`, then wait up to 60
   seconds for a `100.x` address. On timeout it prints `tailscale status` and asks the
   user to paste it into Discord.
5. **Report** `Self.ID` from `tailscale status --json` to `POST /enroll/device`.
6. **Host mode only:**
   - download `mc-host-windows-x64.exe` from the latest release into
     `%LOCALAPPDATA%\mc-host\bin\mc-host.exe` and check it against `SHA256SUMS`;
   - add that folder to the user PATH;
   - write `%APPDATA%\mc-host\agent.json` (the file the agent already reads) with `{ "workerUrl", "token" }`;
   - add a Start Menu shortcut, **Host Minecraft**, that opens a console titled "Minecraft
     host: press Ctrl+C to save and stop. Don't close this window." and runs `mc-host start`;
   - run `mc-host status` as a smoke test.
7. **Done.**
   - Play: "You're on the Minecraft network. Run `/join` in Discord for the address."
   - Host: the same, plus "To host, open **Host Minecraft** from the Start Menu. Press
     Ctrl+C in that window to save and stop."

## Agent on Windows

- **Closing the window.** Bun reports a closed console as SIGHUP. The agent adds it to its
  stop signals (`host/signals.ts`) and sends `stop` so the world on disk is saved. Windows
  kills the process a few seconds later. The lease expires after 10 minutes, and the next
  `mc-host start` on that PC finds the dirty local world and offers to upload it if nobody
  has hosted since (existing crash recovery).
- **`mc-host stop`** on Windows keeps its message: press Ctrl+C in the hosting window.
- **Checked on the clean VM** rather than designed up front: Ctrl+C reaches Java and the
  agent as it does on Linux, the managed JRE's Windows zip extracts and runs, and world zip
  paths round-trip between Windows and Linux snapshots. Any bug found is fixed in this phase.
- **Defender.** Unsigned Bun-compiled executables are sometimes flagged. If the VM test
  hits this, the setup guide documents an exclusion. No code signing.

## Release pipeline (`.github/workflows/release.yml`)

- Triggered by a `v*` tag. It fails if the tag doesn't match `apps/agent/package.json`'s version.
- It runs the Bun tests and the root typecheck (the Worker tests need Cloudflare credentials), then
  `bun build apps/agent/src/cli.ts --compile --target=bun-windows-x64` and `--target=bun-linux-x64`.
- It writes `SHA256SUMS` and creates the GitHub Release with all three files.

## Error handling

Every message is plain English and says what to do next:

| Situation | Message |
|---|---|
| Expired, used or unknown code | "This setup link expired. Run /setup in Discord again." |
| Revoked user runs `/setup` | "You've been removed from the Minecraft network. Ask a maintainer to let you back in." |
| Tailscale API fails during `/enroll` | "Couldn't create your network key. Try again in a minute. If it keeps failing, tell a maintainer." (the code stays usable) |
| Tailscale logged in to another tailnet | "Tailscale on this PC is signed in to another network. This installer won't change it. Ask a maintainer for help." |
| No tailnet address after 60 s | "Tailscale didn't connect. Paste the text below into Discord for a maintainer." plus `tailscale status` |
| Old `mc-host` | "mc-host is out of date. Run `/setup host` in Discord to update." |

## Testing

- **Worker** (Vitest with Miniflare, `fetch` spied with `vi.spyOn` as in Phase 3):
  - `/enroll`: single-use when two redemptions race, expiry, codes from a revoked user,
    `play` mints no token, a failed Tailscale mint leaves the code usable;
  - `/enroll/device`: works only within its window;
  - `/setup` replaces an unused code;
  - `/tailnet revoke`: deletes devices, blocks the token, clears the enrollment, and treats
    a Tailscale 404 as success;
  - `/s/<code>`: fills in the URL and code, and serves the expired script for bad codes;
  - the 426 for old and missing agent versions.
- **Agent:** `--version`, the version header, and SIGHUP as a stop signal.
- **`install.ps1`:** no automated tests. The manual checklist covers it.

## Rollout checklist (`docs/setup/phase-4.md`)

1. `wrangler secret put TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET`, deploy, then
   register commands again.
2. Push `v0.2.0` and check that the release has both binaries and `SHA256SUMS`.
3. On a clean Windows VM:
   - `/setup`: the device appears tagged `mc-player` in the Tailscale admin, and the VM
     joins a world hosted from Fedora through Prism;
   - `/setup host` on the same VM: the Tailscale install is skipped, and `mc-host.exe`, the
     shortcut and the firewall rule appear;
   - host from the shortcut, and Fedora joins it;
   - press Ctrl+C: the world saves and uploads, and the 🔴 announcement appears;
   - close the window while hosting: the next start offers to upload the local world;
   - `/tailnet revoke` the VM's user: the device disappears from the admin and
     `mc-host start` is refused.
4. Invite friends.
