import {
  CreateWorldRequestSchema,
  MintTokenRequestSchema,
  type AdminStatus,
  type CreateWorldResponse,
  type MintTokenResponse,
  type ReleaseResponse,
} from "@mc/protocol";
import { Hono } from "hono";
import { adminAuth } from "../auth";
import type { AppEnv } from "../env";
import { readBody } from "../errors";
import { forceRelease, isHeld, leaseInfo, readLease } from "../lease";
import { listUsers, mintToken } from "../users";
import { activeWorld, createWorld, latestSnapshot, validateWorldFiles } from "../worlds";

export const admin = new Hono<AppEnv>();
admin.use("*", adminAuth);

admin.post("/worlds", async (c) => {
  const req = await readBody(c, CreateWorldRequestSchema);
  const { profile, lock } = await validateWorldFiles(req.profile, req.lockfile);
  const world: CreateWorldResponse = await createWorld(c.env, {
    name: req.name,
    profile,
    lock,
    replace: req.replace,
    imported: req.imported,
    now: Date.now(),
  });
  return c.json(world, 201);
});

admin.post("/tokens", async (c) => {
  const req = await readBody(c, MintTokenRequestSchema);
  const body: MintTokenResponse = { token: await mintToken(c.env.DB, req.discordId, req.name, Date.now()) };
  return c.json(body, 201);
});

admin.post("/lease/release", async (c) => {
  const body: ReleaseResponse = { released: await forceRelease(c.env.DB, Date.now()) };
  return c.json(body);
});

admin.get("/status", async (c) => {
  const now = Date.now();
  const world = await activeWorld(c.env.DB);
  const latest = world ? await latestSnapshot(c.env.DB, world.id) : null;
  const lease = await readLease(c.env.DB);
  const body: AdminStatus = {
    world: world
      ? {
          id: world.id,
          name: world.name,
          minecraft: world.mc_version,
          latestRev: latest?.rev ?? 0,
          latestAt: latest?.created_at ?? null,
          pregenDone: world.pregen_done === 1,
        }
      : null,
    lease: isHeld(lease, now) ? leaseInfo(lease) : null,
    users: await listUsers(c.env.DB),
  };
  return c.json(body);
});
