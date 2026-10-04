import type { LobbyHost } from "@mc/protocol";

export const GAME_PORT = 25565;

/**
 * The console line that tells the lobby-bridge plugin who is hosting. The holder goes last and
 * may contain spaces (the plugin reads the rest of the line); world names are slugs already.
 */
export function bridgeCommand(host: LobbyHost | null): string {
  if (!host) return "lobbybridge none";
  const world = host.world.replace(/\s+/g, "-");
  const name = host.name.replace(/\s+/g, " ").trim() || "Someone";
  return `lobbybridge host ${host.address} ${GAME_PORT} ${world} ${name}`;
}
