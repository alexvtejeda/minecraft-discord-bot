import { InteractionResponseType, InteractionType, type APIInteraction, type APIInteractionResponse } from "discord-api-types/v10";
import { ApiError } from "../errors";
import { CANCEL_ID, parseConfirmId } from "./confirm";
import type { Attachment, Invocation, OptionValue, Registry, RequestMeta } from "./registry";
import { choices, NEEDS_ROLE, OOPS, reply, update } from "./respond";

interface RawOption {
  name: string;
  type: number;
  value?: OptionValue;
  focused?: boolean;
  options?: RawOption[];
}

const SUBCOMMAND = 1;

function flatten(data: { name: string; options?: RawOption[] }) {
  let path = data.name;
  let opts = data.options ?? [];
  if (opts[0]?.type === SUBCOMMAND) {
    path += ` ${opts[0].name}`;
    opts = opts[0].options ?? [];
  }
  const options: Record<string, OptionValue> = {};
  let focused: string | null = null;
  for (const o of opts) {
    if (o.value === undefined) continue;
    options[o.name] = o.value;
    if (o.focused) focused = o.name;
  }
  return { path, options, focused };
}

export async function handleInteraction(i: APIInteraction, req: RequestMeta, registry: Registry): Promise<APIInteractionResponse> {
  if (i.type === InteractionType.Ping) return { type: InteractionResponseType.Pong };
  const roles = i.member?.roles ?? [];
  const inv: Invocation = {
    ...req,
    origin: new URL(req.requestUrl).origin,
    userId: i.member?.user.id ?? i.user?.id ?? "",
    userName: i.member?.user.username ?? i.user?.username ?? "",
    isMaintainer: !!req.env.MAINTAINER_ROLE_ID && roles.includes(req.env.MAINTAINER_ROLE_ID),
    registry,
    interactionToken: (i as { token?: string }).token ?? "",
  };
  const isButton = i.type === InteractionType.MessageComponent;
  const isAutocomplete = i.type === InteractionType.ApplicationCommandAutocomplete;
  try {
    if (i.type === InteractionType.ApplicationCommand || isAutocomplete) {
      const { path, options, focused } = flatten(i.data as unknown as { name: string; options?: RawOption[] });
      const attachments = (i.data as { resolved?: { attachments?: Record<string, Attachment> } }).resolved?.attachments ?? {};
      const cmd = registry.commands.find((c) => c.path === path);
      const allowed = !!cmd && (!cmd.maintainerOnly || inv.isMaintainer);
      if (isAutocomplete) {
        if (!allowed || !cmd.autocomplete || !focused) return choices([]);
        return choices(await cmd.autocomplete({ ...inv, options, attachments }, focused));
      }
      if (!cmd) return reply("I don't know that command. It may have been removed, so try `/help`.");
      if (!allowed) return reply(NEEDS_ROLE);
      return await cmd.run({ ...inv, options, attachments });
    }
    if (isButton) {
      const id = i.data.custom_id;
      if (id === CANCEL_ID) return update("Cancelled. Nothing changed.");
      const parsed = parseConfirmId(id);
      const action = parsed && registry.actions.find((a) => a.name === parsed.action);
      if (!parsed || !action) return update("That button doesn't do anything any more. Run the command again.");
      if (!inv.isMaintainer) return reply(NEEDS_ROLE);
      return await action.run(inv, parsed.args);
    }
    return reply("I don't know how to handle that.");
  } catch (err) {
    if (isAutocomplete) return choices([]);
    const known = err instanceof ApiError;
    if (!known) console.error(`interaction ${i.id} failed`, err);
    const message = known ? err.message : OOPS;
    return isButton ? update(message) : reply(message);
  }
}
