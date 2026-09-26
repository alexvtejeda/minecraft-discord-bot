import type { Command } from "../discord/registry";
import { reply } from "../discord/respond";

export const help: Command = {
  path: "help",
  description: "What each command does",
  maintainerOnly: false,
  async run(c) {
    const lines = c.registry.commands
      .filter((cmd) => !cmd.maintainerOnly || c.isMaintainer)
      .map((cmd) => `\`/${cmd.path}\` ${cmd.maintainerOnly ? "(maintainers) " : ""}— ${cmd.description}`);
    return reply([
      "**Minecraft bot commands**",
      ...lines,
      "",
      "New here? Run `/setup`. To host, run `/setup` with `host` set to True once, then `mc-host start` (or **Host Minecraft** in the Start Menu).",
    ].join("\n"));
  },
};
