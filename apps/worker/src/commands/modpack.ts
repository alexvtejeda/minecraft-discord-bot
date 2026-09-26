import { isVanillaCompatible, parseLock } from "@mc/profile";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { modpackUrl } from "../mrpack";
import { activeWorld } from "../worlds";
import { NO_WORLD } from "./common";

export const modpack: Command = {
  path: "modpack",
  description: "The modpack link for the current world, for Prism Launcher",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
    const who = isVanillaCompatible(lock)
      ? `The modpack is optional on this world: any vanilla ${lock.minecraft} client can join.`
      : "Everyone needs it to join this world.";
    return reply(
      [
        `**${world.name}** modpack: ${modpackUrl(c.origin, world.id)}`,
        "In Prism Launcher: Add Instance → Import, then paste the link.",
        who,
      ].join("\n"),
    );
  },
};
