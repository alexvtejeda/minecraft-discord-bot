# Phase 5: Lobby

Design: [../superpowers/specs/2026-10-03-phase-5-lobby-design.md](../superpowers/specs/2026-10-03-phase-5-lobby-design.md)

The lobby is a Paper server at `mc-lobby` on the tailnet. While someone hosts, it sends
players there; otherwise it's a hangout. It runs on one machine at a time (Fedora now, a
Pi later) and backs itself up to R2.

## 1. Deploy the Worker

```bash
cd apps/worker
bunx wrangler d1 migrations apply mc-bot --remote   # adds users.scope, lobby_slot, lobby_backups
bun run deploy
```

## 2. A lobby token and a Tailscale key

```bash
mc-host admin lobby token fedora     # prints the token once
```

In the Minecraft tailnet's admin console → Settings → Keys → Generate auth key: tag
`tag:mc-player`, pre-approved, not reusable. No policy change is needed: the lobby is a
`tag:mc-player` device on port 25565, which every player can already reach.

## 3. Install on Fedora

Docker, Docker Compose and Bun must be installed (they already are for hosting).

```bash
scripts/install-lobby.sh --worker-url https://mc-bot.<you>.workers.dev --token <lobby token> --authkey tskey-…
mc-lobby logs      # wait for "The lobby is up"
```

`/status` in Discord should now say "Lobby: 🟢 up".

## 4. Day to day

| Command | What it does |
|---|---|
| `mc-lobby console` | The server console. `op <your name>` once, then build in creative. Detach with Ctrl+P, Ctrl+Q. |
| `mc-lobby stop` / `start` | Stop (backs up first) and start again. |
| `mc-lobby logs` | Follow the log. |
| `mc-lobby fresh` | Start an empty lobby, ignoring the backups (only if a backup is broken). |

**Plugins** (WorldEdit, holograms, …): stop the lobby, copy the jar in, start it again.

```bash
mc-lobby stop
docker cp WorldEdit.jar mc-lobby-agent:/data/lobby/server/plugins/
mc-lobby start
```

**A downloaded hub map**: the folder you copy in must contain `level.dat`.

```bash
mc-lobby stop
docker run --rm -v mc-lobby_data:/data -v "$PWD/my-hub-map:/map:ro,z" debian:stable-slim \
  sh -c 'rm -rf /data/lobby/server/world && cp -r /map /data/lobby/server/world'
mc-lobby start
```

Maps and plugins live only in the Docker volume and the R2 backups, never in git.

## 5. Moving to the Pi

1. On Fedora: `mc-lobby stop`. It backs up and frees the slot.
2. In the Tailscale admin console, remove the `mc-lobby` machine, so the Pi gets the name.
3. On the Pi: install Docker and Bun, clone the repo, then run `scripts/install-lobby.sh`
   with a token from `mc-host admin lobby token pi` and a new auth key. It restores the
   latest backup.

If Fedora's lobby is started again by mistake while the Pi runs, it's refused ("The lobby
is already running on pi"). If the Pi is off and Fedora starts, Fedora notices its copy is
older than the Pi's last backup, moves it to `lobby/old-…`, and restores the backup.

## 6. If a lobby machine died

The slot frees itself 2 minutes after the last poll. To free it at once:
`mc-host admin lobby release`.

## Checklist

- [ ] Fedora lobby up; join `mc-lobby` from Prism: superflat, adventure mode, "Nobody's hosting" message
- [ ] Host from the Windows VM: lobby players get the countdown and land on the host
- [ ] `/stay` keeps you in the lobby; `/play` sends you
- [ ] Join `mc-lobby` while the host is up: sent within a second
- [ ] Ctrl+C on the host: everyone is sent back to the lobby, then the world saves
- [ ] `mc-lobby stop`: hosting still works; `/status` shows "Lobby: ⚫ down, so connect straight to …"
- [ ] `mc-lobby start` after 30+ minutes up: `mc-lobby logs` shows "Backed up the lobby as rev N"
- [ ] Delete only the lobby's data (`mc-lobby stop`, then `docker rm mc-lobby-agent` and `docker volume rm mc-lobby_data`; the Tailscale state stays), reinstall: the lobby restores from R2
- [ ] Drop in a downloaded hub map; it survives a stop, a backup and a restore
