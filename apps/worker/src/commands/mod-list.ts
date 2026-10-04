import { parseLock, type Lockfile, type Side } from "@mc/profile";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { BUNDLED_NAMES, bundledProfile } from "../profiles";
import { activeWorld } from "../worlds";
import { NO_WORLD } from "./common";

const SECTIONS: [Side, string][] = [
  ["both", "Everyone needs these"],
  ["server", "Server only"],
  ["client-optional", "Optional for players"],
];

function listMods(heading: string, lock: Lockfile, waiting: string[]): string {
  const lines = [`${heading} (${lock.minecraft}, Fabric ${lock.fabricLoader})`];
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
  return lines.join("\n");
}

export const modList: Command = {
  path: "mod list",
  description: "The mods pinned to the current world, or in one of the bundled profiles",
  maintainerOnly: false,
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: "profile",
      description: "Show this profile's mods instead of the current world's",
      required: false,
      choices: BUNDLED_NAMES.map((n) => ({ name: n, value: n })),
    },
  ],
  async run(c) {
    if (typeof c.options.profile === "string") {
      const b = await bundledProfile(c.options.profile);
      if (!b) return reply(`There's no profile called "${c.options.profile}" in this deploy. Pick one from the list.`);
      return reply(listMods(`**${b.name}** profile`, b.lock, b.profile.waiting));
    }
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
    const waiting = (JSON.parse(world.profile_json) as { waiting?: string[] }).waiting ?? [];
    return reply(listMods(`**${world.name}**`, lock, waiting));
  },
};
