import { GAME_PORT } from "../announce";
import { ago, duration, mention, savedBy } from "../discord/format";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { LOBBY_NAME, lobbyAddress } from "../lobby";
import { activeWorld, latestSnapshot } from "../worlds";
import { NO_WORLD } from "./common";

export const status: Command = {
  path: "status",
  description: "Who's hosting, the address, and when the world was last saved",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const latest = await latestSnapshot(c.env.DB, world.id);
    const lease = await readLease(c.env.DB);
    const lobby = await lobbyAddress(c.env.DB, c.now);
    const saved = latest
      ? `Last saved ${ago(c.now - latest.created_at)} by ${savedBy(latest.uploaded_by)} (rev ${latest.rev}).`
      : "It hasn't been saved yet.";
    const lobbyLine = lobby ? `Lobby: 🟢 up. Connect to \`${LOBBY_NAME}\` and it sends you to whoever is hosting.` : "Lobby: ⚫ down.";
    if (isHeld(lease, c.now) && lease.world_id === world.id) {
      const direct = `${lease.host_address}:${GAME_PORT}`;
      return reply(
        [
          `🟢 ${mention(lease.holder_id!)} is hosting **${world.name}** (${world.mc_version}) at \`${direct}\`.`,
          `Hosting for ${duration(c.now - (lease.claimed_at ?? c.now))}. ${saved}`,
          lobby ? lobbyLine : `Lobby: ⚫ down, so connect straight to \`${direct}\`.`,
        ].join("\n"),
      );
    }
    return reply(
      [
        `Nobody is hosting **${world.name}** (${world.mc_version}) right now.`,
        saved,
        "Anyone with mc-host can start it with `mc-host start`.",
        lobbyLine,
      ].join("\n"),
    );
  },
};
