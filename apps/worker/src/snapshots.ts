import type { UploadTarget } from "@mc/protocol";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { leaseLostError, readLease } from "./lease";
import { storageFor } from "./storage";
import { latestSnapshot, pruneWorld } from "./worlds";

export const KEEP_SNAPSHOTS = 5;

export const snapshotKey = (worldId: string, rev: number) => `worlds/${worldId}/${rev}-${crypto.randomUUID()}.zip`;

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function beginUpload(
  env: Env,
  requestUrl: string,
  o: { worldId: string; baseRev: number; sha256: string },
): Promise<UploadTarget> {
  const latest = (await latestSnapshot(env.DB, o.worldId))?.rev ?? 0;
  if (o.baseRev !== latest) {
    throw new ApiError("stale_rev", `This copy of the world is at rev ${o.baseRev}, but the latest is rev ${latest}.`);
  }
  const rev = latest + 1;
  const key = snapshotKey(o.worldId, rev);
  return { rev, key, ...(await storageFor(env, requestUrl).putTarget(key, o.sha256)) };
}

async function verifyObject(bucket: R2Bucket, o: { worldId: string; rev: number; key: string; size: number; sha256: string }) {
  if (!o.key.startsWith(`worlds/${o.worldId}/${o.rev}-`) || !o.key.endsWith(".zip")) {
    throw new ApiError("bad_request", "That upload key doesn't belong to this world and rev.");
  }
  const head = await bucket.head(o.key);
  if (!head) throw new ApiError("upload_missing", "The upload didn't reach storage. Upload it again.");
  if (head.size !== o.size) {
    throw new ApiError("upload_missing", `The upload is incomplete (${head.size} of ${o.size} bytes). Upload it again.`);
  }
  const sum = head.checksums.sha256;
  if (sum && toHex(sum) !== o.sha256) throw new ApiError("upload_missing", "The upload doesn't match its sha256. Upload it again.");
}

/**
 * Record an uploaded snapshot. With a sessionId, only that session may commit (agent). With
 * null, only while nobody holds the lease (admin import). Either way the rev must be exactly
 * latest + 1. Both checks run inside the INSERT, so a race can't fork the world.
 */
export async function commitSnapshot(
  env: Env,
  o: {
    worldId: string;
    rev: number;
    key: string;
    size: number;
    sha256: string;
    uploadedBy: string;
    now: number;
    pregenDone?: boolean;
    sessionId: string | null;
  },
): Promise<void> {
  await verifyObject(env.BUCKET, o);
  const db = env.DB;
  const guard =
    o.sessionId === null
      ? "NOT EXISTS (SELECT 1 FROM lease WHERE id = 1 AND holder_id IS NOT NULL AND expires_at >= ?8)"
      : "EXISTS (SELECT 1 FROM lease WHERE id = 1 AND session_id = ?8)";
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE ${guard} AND (SELECT COALESCE(MAX(rev), 0) FROM snapshots WHERE world_id = ?1) = ?2 - 1`,
      )
      .bind(o.worldId, o.rev, o.key, o.size, o.sha256, o.uploadedBy, o.now, o.sessionId ?? o.now),
    db
      .prepare(
        "UPDATE lease SET base_rev = ?1 WHERE id = 1 AND session_id = ?2 AND EXISTS (SELECT 1 FROM snapshots WHERE world_id = ?3 AND rev = ?1 AND r2_key = ?4)",
      )
      .bind(o.rev, o.sessionId, o.worldId, o.key),
    db
      .prepare(
        "UPDATE worlds SET pregen_done = 1 WHERE id = ?1 AND ?2 = 1 AND EXISTS (SELECT 1 FROM snapshots WHERE world_id = ?1 AND rev = ?3 AND r2_key = ?4)",
      )
      .bind(o.worldId, o.pregenDone ? 1 : 0, o.rev, o.key),
  ]);
  if (results[0]!.meta.changes !== 1) {
    if (o.sessionId !== null && (await readLease(db)).session_id !== o.sessionId) throw leaseLostError();
    throw new ApiError("stale_rev", `Rev ${o.rev} can't be committed because the world has moved on.`);
  }
  await pruneWorld(env, o.worldId, KEEP_SNAPSHOTS);
}
