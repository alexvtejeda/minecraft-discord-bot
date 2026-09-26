import type { RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import type { Env } from "../env";

export const DISCORD_API = "https://discord.com/api/v10";

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
      "User-Agent": "DiscordBot (https://github.com/alexvtejeda/minecraft-discord-bot, 0.1.0)",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status} to a channel post: ${(await res.text()).slice(0, 300)}`);
}
