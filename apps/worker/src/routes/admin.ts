import {
  CreateWorldRequestSchema,
  ImportCommitRequestSchema,
  ImportUrlRequestSchema,
  MintTokenRequestSchema,
  type AdminStatus,
  type CommitResponse,
  type CreateWorldResponse,
  type MintTokenResponse,
  type ReleaseResponse,
  type UploadTarget,
} from "@mc/protocol";
import { Hono } from "hono";
import { adminAuth } from "../auth";
import type { AppEnv, Env } from "../env";
import { ApiError, readBody } from "../errors";
import { forceRelease, isHeld, leaseInfo, readLease } from "../lease";
import { beginUpload, commitSnapshot } from "../snapshots";
import { listUsers, mintToken } from "../users";
import { activeWorld, createWorld, latestSnapshot, validateWorldFiles, type WorldRow } from "../worlds";

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

/** Import is only for a brand-new world: active, still at rev 0, with nobody hosting. */
async function importableWorld(env: Env, id: string, now: number): Promise<WorldRow> {
  const world = await env.DB.prepare("SELECT * FROM worlds WHERE id = ?").bind(id).first<WorldRow>();
  if (!world || world.status !== "active") throw new ApiError("not_found", "That world doesn't exist or isn't the active one.");
  if (await latestSnapshot(env.DB, id)) {
    throw new ApiError("conflict", `"${world.name}" already has snapshots, so nothing can be imported into it.`);
  }
  const lease = await readLease(env.DB);
  if (isHeld(lease, now)) throw new ApiError("lease_held", "Someone is hosting right now. Import once they stop.", leaseInfo(lease));
  return world;
}

admin.post("/worlds/:id/import-url", async (c) => {
  const req = await readBody(c, ImportUrlRequestSchema);
  const world = await importableWorld(c.env, c.req.param("id"), Date.now());
  const body: UploadTarget = await beginUpload(c.env, c.req.url, { worldId: world.id, baseRev: 0, sha256: req.sha256 });
  return c.json(body);
});

admin.post("/worlds/:id/import-commit", async (c) => {
  const req = await readBody(c, ImportCommitRequestSchema);
  const now = Date.now();
  const world = await importableWorld(c.env, c.req.param("id"), now);
  await commitSnapshot(c.env, { ...req, worldId: world.id, rev: 1, uploadedBy: "admin", now, sessionId: null });
  const body: CommitResponse = { rev: 1 };
  return c.json(body);
});
