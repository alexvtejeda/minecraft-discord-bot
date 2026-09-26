import { GAME_PORT } from "../announce";
import { ago, duration, mention, savedBy } from "../discord/format";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { isHeld, readLease } from "../lease";
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
    const saved = latest
      ? `Last saved ${ago(c.now - latest.created_at)} by ${savedBy(latest.uploaded_by)} (rev ${latest.rev}).`
      : "It hasn't been saved yet.";
    if (isHeld(lease, c.now) && lease.world_id === world.id) {
      return reply(
        [
          `🟢 ${mention(lease.holder_id!)} is hosting **${world.name}** (${world.mc_version}) at \`${lease.host_address}:${GAME_PORT}\`.`,
          `Hosting for ${duration(c.now - (lease.claimed_at ?? c.now))}. ${saved}`,
        ].join("\n"),
      );
    }
    return reply(
      [
        `Nobody is hosting **${world.name}** (${world.mc_version}) right now.`,
        saved,
        "Anyone with mc-host can start it with `mc-host start`.",
      ].join("\n"),
    );
  },
};
