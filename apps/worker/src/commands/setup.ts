import type { Command, CommandContext } from "../discord/registry";
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
    ...(mode === "play" ? ["To host the world too, run `/setup host` instead."] : []),
    "Run `/setup help` any time for how to host, stop and join.",
  ].join("\n");
}

export const SETUP_HELP = [
  "**Hosting the world** (after `/setup host`)",
  "1. Start Menu → **Host Minecraft** (or type `mc-host start` in PowerShell). The first start takes a few minutes.",
  "2. When it says **Players connect to …**, the world is up. Everyone gets the address with `/join`.",
  "3. To stop, press **Ctrl+C** in that window and wait for **Hosting has stopped**. That saves and uploads the world, so don't just close the window.",
  "Only one person can host at a time: `/status` shows who. Keep the PC awake while hosting.",
  "",
  "**Playing**: import the `/modpack` link into Prism Launcher, then join the address from `/join`.",
  "**mc-host says it's out of date?** Run `/setup host` again.",
  "**The setup line says the connection was closed unexpectedly?** Your antivirus blocked it. In Avast, pause the Web Shield for 10 minutes, paste the line again, then turn the shield back on.",
].join("\n");

async function enrollment(c: CommandContext, mode: Mode) {
  if (await isRevoked(c.env.DB, c.userId)) return reply(REVOKED);
  const code = await createEnrollment(c.env.DB, { discordId: c.userId, name: c.userName, mode, now: c.now });
  return reply(setupMessage(c.origin, code, mode));
}

export const setupPlay: Command = {
  path: "setup play",
  description: "Get a one-line installer that puts your Windows PC on the Minecraft network",
  maintainerOnly: false,
  run: (c) => enrollment(c, "play"),
};

export const setupHost: Command = {
  path: "setup host",
  description: "Same as /setup play, and installs mc-host so you can host the world",
  maintainerOnly: false,
  run: (c) => enrollment(c, "host"),
};

export const setupHelp: Command = {
  path: "setup help",
  description: "How to host, stop and join the world",
  maintainerOnly: false,
  async run() {
    return reply(SETUP_HELP);
  },
};
