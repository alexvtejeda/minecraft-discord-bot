import type { UploadTarget } from "@mc/protocol";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { CLEAR_LEASE, isHeld, leaseInfo, leaseLostError, readLease } from "./lease";
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
    // A retry of a commit that already landed (its reply was lost) is not an error.
    const landed = await db
      .prepare("SELECT 1 FROM snapshots WHERE world_id = ? AND rev = ? AND r2_key = ?")
      .bind(o.worldId, o.rev, o.key)
      .first();
    if (!landed) throw new ApiError("stale_rev", `Rev ${o.rev} can't be committed because the world has moved on.`);
  }
  // Best effort: the commit has landed, so a failed cleanup must not turn it into an error.
  try {
    await pruneWorld(env, o.worldId, KEEP_SNAPSHOTS);
  } catch (err) {
    console.error("pruning snapshots failed", err);
  }
}

/**
 * Add rev latest+1 pointing at an older rev's object, so nothing is lost and a rollback can be
 * undone. Refused while someone is hosting. An expired session is cleared so it can't heartbeat
 * back to life and commit on top of the rollback.
 */
export async function rollbackTo(
  env: Pick<Env, "DB" | "BUCKET">,
  o: { worldId: string; rev: number; by: string; now: number },
): Promise<number> {
  const db = env.DB;
  const [inserted] = await db.batch<{ rev: number }>([
    db
      .prepare(
        `INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at)
         SELECT world_id, (SELECT MAX(rev) FROM snapshots WHERE world_id = ?1) + 1, r2_key, size, sha256, ?3, ?4
         FROM snapshots
         WHERE world_id = ?1 AND rev = ?2
           AND rev < (SELECT MAX(rev) FROM snapshots WHERE world_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM lease WHERE id = 1 AND holder_id IS NOT NULL AND expires_at >= ?4)
         RETURNING rev`,
      )
      .bind(o.worldId, o.rev, `rollback:${o.by}`, o.now),
    db.prepare(`${CLEAR_LEASE} WHERE id = 1 AND holder_id IS NOT NULL AND expires_at < ?`).bind(o.now),
  ]);
  const newRev = inserted!.results[0]?.rev;
  if (newRev === undefined) {
    const lease = await readLease(db);
    if (isHeld(lease, o.now)) throw new ApiError("lease_held", "Someone is hosting right now. Roll back once they stop.", leaseInfo(lease));
    const latest = await latestSnapshot(db, o.worldId);
    if (latest?.rev === o.rev) throw new ApiError("conflict", `Rev ${o.rev} is already the latest.`);
    throw new ApiError("not_found", `Rev ${o.rev} isn't kept any more. Only the last ${KEEP_SNAPSHOTS} saves are kept.`);
  }
  try {
    await pruneWorld(env, o.worldId, KEEP_SNAPSHOTS);
  } catch (err) {
    console.error("pruning snapshots failed", err);
  }
  return newRev;
}
