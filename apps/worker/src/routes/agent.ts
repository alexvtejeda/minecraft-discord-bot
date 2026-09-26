import {
  ClaimRequestSchema,
  CommitRequestSchema,
  SessionRequestSchema,
  UploadUrlRequestSchema,
  type ClaimResponse,
  type CommitResponse,
  type HeartbeatResponse,
  type Manifest,
  type Ok,
  type UploadTarget,
} from "@mc/protocol";
import { Hono } from "hono";
import { announceStarted, announceStopped } from "../announce";
import { agentAuth } from "../auth";
import type { AppEnv } from "../env";
import { readBody } from "../errors";
import { claimLease, heartbeatLease, isHeld, leaseInfo, readLease, releaseLease, requireSession } from "../lease";
import { beginUpload, commitSnapshot } from "../snapshots";
import { storageFor } from "../storage";
import { latestSnapshot, requireActiveWorld } from "../worlds";

export const agent = new Hono<AppEnv>();
agent.use("*", agentAuth);

agent.get("/manifest", async (c) => {
  const db = c.env.DB;
  const world = await requireActiveWorld(db);
  const latest = await latestSnapshot(db, world.id);
  const lease = await readLease(db);
  const body: Manifest = {
    world: { id: world.id, name: world.name, minecraft: world.mc_version },
    profile: JSON.parse(world.profile_json),
    lockfile: JSON.parse(world.lockfile_json),
    pregenDone: world.pregen_done === 1,
    latest: latest
      ? { rev: latest.rev, sha256: latest.sha256, size: latest.size, url: await storageFor(c.env, c.req.url).getUrl(latest.r2_key) }
      : null,
    lease: isHeld(lease, Date.now()) ? { ...leaseInfo(lease), you: lease.holder_id === c.var.userId } : null,
  };
  return c.json(body);
});

agent.post("/lease/claim", async (c) => {
  const { hostAddress } = await readBody(c, ClaimRequestSchema);
  const world = await requireActiveWorld(c.env.DB);
  const body: ClaimResponse = await claimLease(c.env.DB, { userId: c.var.userId, hostAddress, worldId: world.id, now: Date.now() });
  announceStarted(c.env, c.executionCtx, { userId: c.var.userId, worldName: world.name, minecraft: world.mc_version, hostAddress });
  return c.json(body);
});

agent.post("/lease/heartbeat", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  const body: HeartbeatResponse = { expiresAt: await heartbeatLease(c.env.DB, sessionId, Date.now()) };
  return c.json(body);
});

agent.post("/lease/release", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  const lease = await requireSession(c.env.DB, sessionId);
  await releaseLease(c.env.DB, sessionId);
  const latest = await latestSnapshot(c.env.DB, lease.world_id);
  announceStopped(c.env, c.executionCtx, { userId: c.var.userId, rev: latest?.rev ?? null });
  const body: Ok = { ok: true };
  return c.json(body);
});

agent.post("/snapshot/upload-url", async (c) => {
  const req = await readBody(c, UploadUrlRequestSchema);
  const lease = await requireSession(c.env.DB, req.sessionId);
  const body: UploadTarget = await beginUpload(c.env, c.req.url, { worldId: lease.world_id, baseRev: req.baseRev, sha256: req.sha256 });
  return c.json(body);
});

agent.post("/snapshot/commit", async (c) => {
  const req = await readBody(c, CommitRequestSchema);
  const lease = await requireSession(c.env.DB, req.sessionId);
  await commitSnapshot(c.env, { ...req, worldId: lease.world_id, uploadedBy: c.var.userId, now: Date.now() });
  const body: CommitResponse = { rev: req.rev };
  return c.json(body);
});
