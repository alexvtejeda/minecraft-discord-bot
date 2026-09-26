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
      "New here? Run `/setup play`, or `/setup host` to host too. `/setup help` shows how to host and stop.",
    ].join("\n"));
  },
};
