import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import type { Command, Registry } from "./registry";

/**
 * Registration JSON built from the same registry the router dispatches from. A command is
 * hidden from non-maintainers (default_member_permissions "0") only if all of it is
 * maintainer-only; the router's role check is what enforces access either way.
 */
export function toDiscordCommands(r: Registry): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const top: Command[] = [];
  const groups = new Map<string, Command[]>();
  for (const c of r.commands) {
    const [group, sub] = c.path.split(" ");
    if (sub) groups.set(group!, [...(groups.get(group!) ?? []), c]);
    else top.push(c);
  }
  const hidden = (cs: Command[]) => (cs.every((c) => c.maintainerOnly) ? { default_member_permissions: "0" } : {});
  return [
    ...top.map((c) => ({
      type: ApplicationCommandType.ChatInput as const,
      name: c.path,
      description: c.description,
      options: c.options ?? [],
      ...hidden([c]),
    })),
    ...[...groups].map(([name, subs]) => ({
      type: ApplicationCommandType.ChatInput as const,
      name,
      description: r.groups[name] ?? name,
      ...hidden(subs),
      options: subs.map((s) => ({
        type: ApplicationCommandOptionType.Subcommand as const,
        name: s.path.split(" ")[1]!,
        description: s.description,
        options: s.options ?? [],
      })),
    })),
  ];
}
