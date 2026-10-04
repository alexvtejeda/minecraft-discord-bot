import {
  LobbyClaimRequestSchema,
  LobbyCommitRequestSchema,
  LobbyUploadUrlRequestSchema,
  SessionRequestSchema,
  type CommitResponse,
  type LobbyClaimResponse,
  type LobbyLatestResponse,
  type LobbyPollResponse,
  type Ok,
  type UploadTarget,
} from "@mc/protocol";
import { Hono } from "hono";
import { lobbyAuth } from "../auth";
import type { AppEnv } from "../env";
import { readBody } from "../errors";
import { beginLobbyUpload, commitLobbyBackup, latestBackup } from "../lobby-backups";
import { claimSlot, lobbyHost, pollSlot, releaseSlot } from "../lobby";
import { storageFor } from "../storage";
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

lobby.post("/backup/upload-url", async (c) => {
  const req = await readBody(c, LobbyUploadUrlRequestSchema);
  const body: UploadTarget = await beginLobbyUpload(c.env, c.req.url, req);
  return c.json(body);
});

lobby.post("/backup/commit", async (c) => {
  const req = await readBody(c, LobbyCommitRequestSchema);
  await commitLobbyBackup(c.env, { ...req, now: Date.now() });
  const body: CommitResponse = { rev: req.rev };
  return c.json(body);
});

lobby.get("/backup/latest", async (c) => {
  const row = await latestBackup(c.env.DB);
  const body: LobbyLatestResponse = {
    latest: row ? { rev: row.rev, sha256: row.sha256, size: row.size, url: await storageFor(c.env, c.req.url).getUrl(row.r2_key) } : null,
  };
  return c.json(body);
});
