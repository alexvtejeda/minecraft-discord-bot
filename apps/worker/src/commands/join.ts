import { isVanillaCompatible, parseLock } from "@mc/profile";
import { GAME_PORT } from "../announce";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { LOBBY_NAME, lobbyAddress } from "../lobby";
import { modpackUrl } from "../mrpack";
import { activeWorld } from "../worlds";
import { NO_WORLD } from "./common";

export const join: Command = {
  path: "join",
  description: "How to connect to the server",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
    const url = modpackUrl(c.origin, world.id);
    const lease = await readLease(c.env.DB);
    const pack = isVanillaCompatible(lock)
      ? `Any vanilla ${lock.minecraft} client can join. For the recommended extras, import the modpack in Prism (Add Instance → Import, paste the link): ${url}`
      : `In Prism, Add Instance → Import, and paste: ${url}`;
    const lobby = await lobbyAddress(c.env.DB, c.now);
    const hosting = isHeld(lease, c.now) && lease.world_id === world.id;
    const address = lobby
      ? `Add a server with the address \`${LOBBY_NAME}\` (once). It sends you to whoever is hosting. If that name doesn't connect, use \`${lobby.address}\`.`
      : hosting
        ? `The lobby is down, so connect straight to \`${lease.host_address}:${GAME_PORT}\`.`
        : "Nobody is hosting right now. `/status` shows the address once someone starts.";
    return reply(
      [
        `**Joining ${world.name}** (${lock.minecraft})`,
        "1. Install Prism Launcher: https://prismlauncher.org",
        `2. ${pack}`,
        `3. ${address}`,
        "",
        "You need to be on the Minecraft tailnet to connect. Ask a maintainer to get you onto the tailnet.",
      ].join("\n"),
    );
  },
};
