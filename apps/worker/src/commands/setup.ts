import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";
import { createEnrollment, type Mode } from "../enroll";
import { isRevoked } from "../users";

export const REVOKED = "You've been removed from the Minecraft network. Ask a maintainer to let you back in.";

export function setupMessage(origin: string, code: string, mode: Mode): string {
  return [
    mode === "host" ? "**Set up this PC to play and host** (Windows)" : "**Join the Minecraft network** (Windows)",
    "1. Open PowerShell: Start → type **PowerShell** → Enter.",
    "2. Paste this line and press Enter:",
    "```",
    `irm ${origin}/s/${code} | iex`,
    "```",
    "3. Click **Yes** when Windows asks for permission.",
    "",
    "This line is just for you. It works once and expires in 15 minutes.",
    ...(mode === "play" ? ["To host the world too, run `/setup` with `host` set to True."] : []),
  ].join("\n");
}

export const setup: Command = {
  path: "setup",
  description: "Get a one-line installer that puts your Windows PC on the Minecraft network",
  maintainerOnly: false,
  options: [
    { type: ApplicationCommandOptionType.Boolean, name: "host", description: "Also install mc-host so you can host the world", required: false },
  ],
  async run(c) {
    if (await isRevoked(c.env.DB, c.userId)) return reply(REVOKED);
    const mode: Mode = c.options.host === true ? "host" : "play";
    const code = await createEnrollment(c.env.DB, { discordId: c.userId, name: c.userName, mode, now: c.now });
    return reply(setupMessage(c.origin, code, mode));
  },
};
