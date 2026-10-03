import { parseLock, type Side } from "@mc/profile";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { activeWorld } from "../worlds";
import { NO_WORLD } from "./common";

const SECTIONS: [Side, string][] = [
  ["both", "Everyone needs these"],
  ["server", "Server only"],
  ["client-optional", "Optional for players"],
];

export const modList: Command = {
  path: "mod list",
  description: "The mods pinned to the current world",
  maintainerOnly: false,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
    const waiting = (JSON.parse(world.profile_json) as { waiting?: string[] }).waiting ?? [];
    const lines = [`**${world.name}** (${lock.minecraft}, Fabric ${lock.fabricLoader})`];
    for (const [side, title] of SECTIONS) {
      const files = lock.files.filter((f) => f.side === side);
      if (!files.length) continue;
      lines.push("", `__${title}__`);
      for (const f of files) {
        const notes = [
          f.side === "both" && f.clientOptional ? "optional" : "",
          f.auto ? "dependency" : "",
          f.source === "jar" ? "uploaded" : "",
        ].filter(Boolean);
        lines.push(`- ${f.slug} ${f.versionNumber}${notes.length ? ` (${notes.join(", ")})` : ""}`);
      }
    }
    if (waiting.length) lines.push("", `__Waiting for a ${lock.minecraft} release__`, waiting.join(", "));
    return reply(lines.join("\n"));
  },
};
