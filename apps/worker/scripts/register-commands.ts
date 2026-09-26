// Registers the slash commands in one Discord server (guild commands update instantly).
// Usage: DISCORD_APP_ID=… DISCORD_GUILD_ID=… DISCORD_BOT_TOKEN=… bun run --cwd apps/worker register
import { REGISTRY } from "../src/commands";
import { toDiscordCommands } from "../src/discord/definitions";
import { DISCORD_API } from "../src/discord/rest";

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} first. See docs/setup/phase-3.md.`);
    process.exit(1);
  }
  return value;
}

const appId = need("DISCORD_APP_ID");
const guildId = need("DISCORD_GUILD_ID");
const token = need("DISCORD_BOT_TOKEN");

const res = await fetch(`${DISCORD_API}/applications/${appId}/guilds/${guildId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(toDiscordCommands(REGISTRY)),
});
if (!res.ok) {
  console.error(`Discord answered ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const registered = (await res.json()) as { name: string }[];
console.log(`Registered ${registered.length} commands: ${registered.map((c) => `/${c.name}`).join(", ")}`);
