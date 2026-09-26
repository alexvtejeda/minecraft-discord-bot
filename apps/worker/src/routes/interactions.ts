import { Hono } from "hono";
import { verifyDiscordRequest } from "../discord/verify";
import type { AppEnv } from "../env";

export const interactions = new Hono<AppEnv>();

interactions.post("/", async (c) => {
  const body = await c.req.text();
  const ok = await verifyDiscordRequest(
    c.env.DISCORD_PUBLIC_KEY,
    c.req.header("X-Signature-Ed25519"),
    c.req.header("X-Signature-Timestamp"),
    body,
  );
  if (!ok) return c.text("Bad request signature.", 401);
  const interaction = JSON.parse(body) as { type: number };
  if (interaction.type === 1) return c.json({ type: 1 });
  return c.json({ error: "unsupported" }, 400);
});
