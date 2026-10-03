import type {
  APIApplicationCommandBasicOption,
  APIApplicationCommandOptionChoice,
  APIInteractionResponse,
} from "discord-api-types/v10";
import type { Env } from "../env";

export type OptionValue = string | number | boolean;

export interface Attachment {
  url: string;
  filename: string;
  size: number;
}

/** What the router knows about the HTTP request, before looking at who sent it. */
export interface RequestMeta {
  env: Env;
  exec: Pick<ExecutionContext, "waitUntil">;
  requestUrl: string;
  now: number;
}

export interface Invocation extends RequestMeta {
  /** This Worker's origin, for links back to it. */
  origin: string;
  userId: string;
  /** Discord username (not the display name); used for tailnet hostnames. */
  userName: string;
  isMaintainer: boolean;
  registry: Registry;
  /** For editing a deferred reply. */
  interactionToken: string;
}

export interface CommandContext extends Invocation {
  options: Record<string, OptionValue>;
  /** Attachment options, by the attachment ID that is the option's value. */
  attachments: Record<string, Attachment>;
}

export interface Command {
  /** "status", or group + subcommand: "world rollback". */
  path: string;
  description: string;
  maintainerOnly: boolean;
  options?: APIApplicationCommandBasicOption[];
  run(c: CommandContext): Promise<APIInteractionResponse>;
  /** `focused` is the option being typed; its partial value is in `c.options`. */
  autocomplete?(c: CommandContext, focused: string): Promise<APIApplicationCommandOptionChoice[]>;
}

/** What a Confirm button does. Always maintainer-only. */
export interface ConfirmAction {
  name: string;
  run(c: Invocation, args: string[]): Promise<APIInteractionResponse>;
}

export interface Registry {
  commands: Command[];
  actions: ConfirmAction[];
  /** Descriptions of subcommand groups, e.g. { world: "…" }. */
  groups: Record<string, string>;
}
