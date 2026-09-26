import { ago, size } from "../discord/format";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { storageFor } from "../storage";
import { activeWorld, latestSnapshot } from "../worlds";
import { NO_WORLD } from "./common";

export const worldDownload: Command = {
  path: "world download",
  description: "A download link for the latest save of the current world",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const latest = await latestSnapshot(c.env.DB, world.id);
    if (!latest) return reply(`**${world.name}** hasn't been saved yet, so there's nothing to download.`);
    const url = await storageFor(c.env, c.requestUrl).getUrl(latest.r2_key);
    return reply(
      [
        `**${world.name}** rev ${latest.rev} (${size(latest.size)}, saved ${ago(c.now - latest.created_at)}): ${url}`,
        "The link works for 1 hour.",
      ].join("\n"),
    );
  },
};
