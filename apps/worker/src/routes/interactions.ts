import type { APIInteraction } from "discord-api-types/v10";
import { Hono } from "hono";
import { REGISTRY } from "../commands";
import { handleInteraction } from "../discord/router";
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
  const interaction = JSON.parse(body) as APIInteraction;
  return c.json(await handleInteraction(interaction, { env: c.env, exec: c.executionCtx as ExecutionContext, requestUrl: c.req.url, now: Date.now() }, REGISTRY));
});
