#!/usr/bin/env bash
# Install the lobby (Phase 5) on Linux: Paper in Docker behind its own Tailscale sidecar, named
# mc-lobby on the Minecraft tailnet. Run it from the repo checkout. Running it again rebuilds
# mc-host and the plugin and keeps the lobby's data.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-lobby.sh --worker-url <url> --token <lobby token> --authkey <tskey-...>

  --worker-url   the Worker's URL, e.g. https://mc-bot.<you>.workers.dev
  --token        a lobby token (mc-host admin lobby token <this machine's name>)
  --authkey      a tagged (tag:mc-player), pre-approved Tailscale auth key for the Minecraft tailnet

After the first install, every flag is optional; missing ones keep their current values.
EOF
}

WORKER_URL="" TOKEN="" AUTHKEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker-url) WORKER_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --authkey) AUTHKEY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${XDG_DATA_HOME:-$HOME/.local/share}/mc-lobby"
BIN="$HOME/.local/bin"
ENV_FILE="$APP/.env"

command -v docker >/dev/null || { echo "Docker isn't installed. See https://docs.docker.com/engine/install/, then run this again." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose isn't installed. Install the docker-compose-plugin package, then run this again." >&2; exit 1; }
command -v bun >/dev/null || { echo "Bun is needed to build mc-host. Install it from https://bun.sh, then run this again." >&2; exit 1; }

current() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
OLD_AUTHKEY="$(current TS_AUTHKEY)"
WORKER_URL="${WORKER_URL:-$(current MC_WORKER_URL)}"
TOKEN="${TOKEN:-$(current MC_TOKEN)}"
AUTHKEY="${AUTHKEY:-$OLD_AUTHKEY}"
if [[ -z "$WORKER_URL" || -z "$TOKEN" || -z "$AUTHKEY" ]]; then
  echo "The first install needs --worker-url, --token and --authkey." >&2
  usage >&2
  exit 1
fi

if [[ "$(current MC_ACCEPT_EULA)" != "true" ]]; then
  echo "The lobby runs a Minecraft server, which means agreeing to Mojang's EULA: https://aka.ms/MinecraftEULA"
  read -r -p 'Type "yes" to agree: ' answer
  if [[ "${answer,,}" != "yes" ]]; then echo "You need to agree to the EULA to run the lobby." >&2; exit 1; fi
fi

mkdir -p "$APP/build" "$BIN"
compose() { docker compose --project-directory "$APP" -f "$APP/compose.yml" --env-file "$ENV_FILE" "$@"; }

# A new auth key only takes effect on a fresh Tailscale state.
if [[ -n "$OLD_AUTHKEY" && "$AUTHKEY" != "$OLD_AUTHKEY" ]]; then
  echo "New auth key: resetting the Tailscale sidecar's state."
  compose down >/dev/null 2>&1 || true
  docker volume rm mc-lobby_tailscale-state >/dev/null 2>&1 || true
fi

(umask 077 && printf 'MC_WORKER_URL=%s\nMC_TOKEN=%s\nTS_AUTHKEY=%s\nMC_ACCEPT_EULA=true\nMC_LOBBY_MACHINE=%s\n' \
  "$WORKER_URL" "$TOKEN" "$AUTHKEY" "$(hostname -s)" > "$ENV_FILE")
chmod 600 "$ENV_FILE"

echo "Building mc-host…"
(cd "$REPO" && bun install --frozen-lockfile >/dev/null && bun build apps/agent/src/cli.ts --compile --outfile "$APP/build/mc-host" >/dev/null)
echo "Building the lobby-bridge plugin (the first time downloads Gradle's dependencies)…"
"$REPO/scripts/gradle.sh" build
cp "$REPO/paper/lobby-bridge/build/libs/lobby-bridge.jar" "$APP/build/lobby-bridge.jar"
cp "$REPO/infra/docker/lobby.Dockerfile" "$APP/build/Dockerfile"
echo "Building the mc-lobby:local image…"
docker build -q -t mc-lobby:local "$APP/build" >/dev/null
cp "$REPO/infra/docker/lobby-compose.yml" "$APP/compose.yml"

cat > "$BIN/mc-lobby" <<'SHIM'
#!/usr/bin/env bash
# Installed by minecraft-discord-bot/scripts/install-lobby.sh
set -euo pipefail
APP="${XDG_DATA_HOME:-$HOME/.local/share}/mc-lobby"
compose() { docker compose --project-directory "$APP" -f "$APP/compose.yml" --env-file "$APP/.env" "$@"; }
case "${1:-}" in
  start) compose up -d ;;
  stop) compose stop agent ;;
  console)
    echo "Server console. Detach with Ctrl+P then Ctrl+Q. (Ctrl+C restarts the lobby; use 'mc-lobby stop' to stop it.)"
    exec docker attach mc-lobby-agent ;;
  logs) exec docker logs -f --tail 100 mc-lobby-agent ;;
  status) compose ps ;;
  fresh)
    compose stop agent
    echo "Starting an empty lobby (the backups stay in R2). Ctrl+C backs it up and stops it; then run 'mc-lobby start'."
    compose run --rm -it agent lobby --fresh ;;
  *) echo "Usage: mc-lobby start|stop|console|logs|status|fresh" >&2; exit 1 ;;
esac
SHIM
chmod +x "$BIN/mc-lobby"

compose up -d
echo
echo "The lobby is starting. Watch it with: mc-lobby logs   (the first start downloads Java and Paper)"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH to use the mc-lobby command." ;; esac
