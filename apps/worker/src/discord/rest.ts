import type { RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import type { Env } from "../env";
import { fit } from "./respond";

export const DISCORD_API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/alexvtejeda/minecraft-discord-bot, 0.1.0)";

export async function postMessage(
  env: Pick<Env, "DISCORD_BOT_TOKEN">,
  channelId: string,
  body: RESTPostAPIChannelMessageJSONBody,
): Promise<void> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status} to a channel post: ${(await res.text()).slice(0, 300)}`);
}

/** Replace a deferred reply's "thinking…" with the result. */
export async function editOriginal(env: Pick<Env, "DISCORD_APP_ID">, token: string, content: string): Promise<void> {
  const res = await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ content: fit(content), allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status} to a reply edit: ${(await res.text()).slice(0, 300)}`);
}
