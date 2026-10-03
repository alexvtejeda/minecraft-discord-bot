import {
  InteractionResponseType,
  MessageFlags,
  type APIActionRowComponent,
  type APIApplicationCommandOptionChoice,
  type APIButtonComponent,
  type APIInteractionResponse,
} from "discord-api-types/v10";

export const MAX_CONTENT = 2000;
export const NEEDS_ROLE = "That needs the MC Maintainer role.";
export const STALE = "Things changed since the preview. Run the command again.";
export const OOPS = "Something went wrong on my end, try again in a minute.";

const CUT_NOTE = "\n…(cut to fit Discord's limit)";

/** Discord rejects messages over 2000 characters, so cut at a line break and say so. */
export function fit(content: string): string {
  if (content.length <= MAX_CONTENT) return content;
  const cut = content.slice(0, MAX_CONTENT - CUT_NOTE.length);
  const nl = cut.lastIndexOf("\n");
  return (nl > 0 ? cut.slice(0, nl) : cut) + CUT_NOTE;
}

/** An ephemeral reply that never pings anyone. */
export function reply(content: string, components?: APIActionRowComponent<APIButtonComponent>[]): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content: fit(content), flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) },
  };
}

/** Replace the message a button was on, dropping its buttons so it can't be clicked twice. */
export function update(content: string): APIInteractionResponse {
  return { type: InteractionResponseType.UpdateMessage, data: { content: fit(content), components: [], allowed_mentions: { parse: [] } } };
}

export function choices(list: APIApplicationCommandOptionChoice[]): APIInteractionResponse {
  return { type: InteractionResponseType.ApplicationCommandAutocompleteResult, data: { choices: list.slice(0, 25) } };
}

/** "Thinking…" for work that may outlast Discord's 3-second limit. Finish it with editOriginal. */
export function deferred(): APIInteractionResponse {
  return { type: InteractionResponseType.DeferredChannelMessageWithSource, data: { flags: MessageFlags.Ephemeral } };
}
