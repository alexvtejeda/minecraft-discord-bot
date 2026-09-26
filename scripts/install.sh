#!/usr/bin/env bash
# Install mc-host for hosting from Linux: Docker + a Tailscale sidecar on the Minecraft tailnet.
# Run it from the repo checkout. Running it again is safe, and it can rotate the token or auth key.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install.sh --worker-url <url> --token <agent token> --authkey <tskey-...> [--name <host name>]

  --worker-url   the Worker's URL, e.g. https://mc-bot.<you>.workers.dev
  --token        your hosting token (mc-host admin token mint …)
  --authkey      a tagged, pre-authorized Tailscale auth key for the Minecraft tailnet
  --name         tailnet host name suffix (default: this machine's short hostname)

After the first install, every flag is optional; missing ones keep their current values.
EOF
}

WORKER_URL="" TOKEN="" AUTHKEY="" NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker-url) WORKER_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --authkey) AUTHKEY="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${XDG_DATA_HOME:-$HOME/.local/share}/mc-host"
BIN="$HOME/.local/bin"
ENV_FILE="$APP/.env"

command -v docker >/dev/null || { echo "Docker isn't installed. See https://docs.docker.com/engine/install/fedora/ (or /debian/), then run this again." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose isn't installed. Install the docker-compose-plugin package, then run this again." >&2; exit 1; }
command -v bun >/dev/null || { echo "Bun is needed to build mc-host. Install it from https://bun.sh, then run this again." >&2; exit 1; }

current() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
OLD_AUTHKEY="$(current TS_AUTHKEY)"
WORKER_URL="${WORKER_URL:-$(current MC_WORKER_URL)}"
TOKEN="${TOKEN:-$(current MC_TOKEN)}"
AUTHKEY="${AUTHKEY:-$OLD_AUTHKEY}"
HOSTNAME_NOW="$(current TS_HOSTNAME)"
TS_HOSTNAME="mc-${NAME:-$(hostname -s)}"
[[ -z "$NAME" && -n "$HOSTNAME_NOW" ]] && TS_HOSTNAME="$HOSTNAME_NOW"
if [[ -z "$WORKER_URL" || -z "$TOKEN" || -z "$AUTHKEY" ]]; then
  echo "The first install needs --worker-url, --token and --authkey." >&2
  usage >&2
  exit 1
fi

mkdir -p "$APP/build" "$BIN"
compose() { docker compose --project-directory "$APP" -f "$APP/compose.yml" --env-file "$ENV_FILE" "$@"; }

# A new auth key only takes effect on a fresh Tailscale state.
if [[ -n "$OLD_AUTHKEY" && "$AUTHKEY" != "$OLD_AUTHKEY" ]]; then
  echo "New auth key: resetting the Tailscale sidecar's state."
  compose down >/dev/null 2>&1 || true
  docker volume rm mc-host_tailscale-state >/dev/null 2>&1 || true
fi

(umask 077 && printf 'MC_WORKER_URL=%s\nMC_TOKEN=%s\nTS_AUTHKEY=%s\nTS_HOSTNAME=%s\n' \
  "$WORKER_URL" "$TOKEN" "$AUTHKEY" "$TS_HOSTNAME" > "$ENV_FILE")
chmod 600 "$ENV_FILE"

echo "Building mc-host…"
(cd "$REPO" && bun install --frozen-lockfile >/dev/null && bun build apps/agent/src/cli.ts --compile --outfile "$APP/build/mc-host" >/dev/null)
cp "$REPO/infra/docker/Dockerfile" "$APP/build/Dockerfile"
echo "Building the mc-host:local image…"
docker build -q -t mc-host:local "$APP/build" >/dev/null
cp "$REPO/infra/docker/compose.yml" "$APP/compose.yml"
cp "$APP/build/mc-host" "$APP/mc-host-native"

cat > "$BIN/mc-host" <<'SHIM'
#!/usr/bin/env bash
# Installed by minecraft-discord-bot/scripts/install.sh
set -euo pipefail
APP="${XDG_DATA_HOME:-$HOME/.local/share}/mc-host"
compose() { docker compose --project-directory "$APP" -f "$APP/compose.yml" --env-file "$APP/.env" "$@"; }
case "${1:-}" in
  start)
    exec compose run --rm -it --name mc-host-agent agent start ;;
  stop)
    if docker ps --format '{{.Names}}' | grep -qx mc-host-agent; then
      exec docker kill -s SIGINT mc-host-agent
    fi
    echo "Nobody is hosting from this PC." ;;
  status)
    exec compose run --rm -T agent status ;;
  *)
    exec "$APP/mc-host-native" "$@" ;;
esac
SHIM
chmod +x "$BIN/mc-host"

echo
echo "Installed. Host with: mc-host start   (Ctrl+C or 'mc-host stop' saves and stops)"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH to use the mc-host command." ;; esac
