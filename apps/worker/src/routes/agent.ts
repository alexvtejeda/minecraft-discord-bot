import {
  ClaimRequestSchema,
  SessionRequestSchema,
  type ClaimResponse,
  type HeartbeatResponse,
  type Manifest,
  type Ok,
} from "@mc/protocol";
import { Hono } from "hono";
import { agentAuth } from "../auth";
import type { AppEnv } from "../env";
import { readBody } from "../errors";
import { claimLease, heartbeatLease, isHeld, leaseInfo, readLease, releaseLease } from "../lease";
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
  return c.json(body);
});

agent.post("/lease/heartbeat", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  const body: HeartbeatResponse = { expiresAt: await heartbeatLease(c.env.DB, sessionId, Date.now()) };
  return c.json(body);
});

agent.post("/lease/release", async (c) => {
  const { sessionId } = await readBody(c, SessionRequestSchema);
  await releaseLease(c.env.DB, sessionId);
  const body: Ok = { ok: true };
  return c.json(body);
});
