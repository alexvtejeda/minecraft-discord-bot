import { LobbyClaimRequestSchema, SessionRequestSchema, type LobbyClaimResponse, type LobbyPollResponse, type Ok } from "@mc/protocol";
import { Hono } from "hono";
import { lobbyAuth } from "../auth";
import type { AppEnv } from "../env";
import { readBody } from "../errors";
import { claimSlot, lobbyHost, pollSlot, releaseSlot } from "../lobby";
import { versionCheck } from "../version";

export const lobby = new Hono<AppEnv>();
lobby.use("*", versionCheck);
lobby.use("*", lobbyAuth);

lobby.post("/claim", async (c) => {
  const req = await readBody(c, LobbyClaimRequestSchema);
  const body: LobbyClaimResponse = await claimSlot(c.env.DB, { ...req, userId: c.var.userId, now: Date.now() });
  return c.json(body);
});

/** The lobby's heartbeat, answered with who it should send players to. */
lobby.post("/poll", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  const now = Date.now();
  const expiresAt = await pollSlot(c.env.DB, sessionId, now);
  const body: LobbyPollResponse = { host: await lobbyHost(c.env.DB, now), expiresAt };
  return c.json(body);
});

lobby.post("/release", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  await releaseSlot(c.env.DB, sessionId);
  const body: Ok = { ok: true };
  return c.json(body);
});
