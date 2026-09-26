import { parseLock, parseProfile, profileHash, serializeLock, type Lockfile, type Profile } from "@mc/profile";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { CLEAR_LEASE, isHeld, leaseInfo, readLease } from "./lease";

export interface WorldRow {
  id: string;
  name: string;
  mc_version: string;
  profile_json: string;
  lockfile_json: string;
  status: "active" | "archived";
  pregen_done: number;
  created_at: number;
}

export interface SnapshotRow {
  world_id: string;
  rev: number;
  r2_key: string;
  size: number;
  sha256: string;
  uploaded_by: string;
  created_at: number;
}

const MAX_WORLD_FILES_BYTES = 1_000_000;

export const activeWorld = (db: D1Database) => db.prepare("SELECT * FROM worlds WHERE status = 'active'").first<WorldRow>();

export async function requireActiveWorld(db: D1Database): Promise<WorldRow> {
  const w = await activeWorld(db);
  if (!w) throw new ApiError("no_active_world", "No world is active yet. A maintainer runs `mc-host admin world create <profile>`.");
  return w;
}

export const latestSnapshot = (db: D1Database, worldId: string) =>
  db.prepare("SELECT * FROM snapshots WHERE world_id = ? ORDER BY rev DESC LIMIT 1").bind(worldId).first<SnapshotRow>();

/** Parse both files with the same code the agent uses, and check that they belong together. */
export async function validateWorldFiles(rawProfile: unknown, rawLock: unknown): Promise<{ profile: Profile; lock: Lockfile }> {
  let profile: Profile;
  let lock: Lockfile;
  try {
    profile = parseProfile(rawProfile, "profile");
    lock = parseLock(JSON.stringify(rawLock), "lockfile");
  } catch (err) {
    throw new ApiError("bad_request", (err as Error).message);
  }
  if (lock.profile !== profile.name || lock.profileHash !== (await profileHash(profile))) {
    throw new ApiError(
      "bad_request",
      `The lockfile doesn't match the ${profile.name} profile. Run "mc-host profile resolve ${profile.name}" and try again.`,
    );
  }
  if (JSON.stringify(profile).length + serializeLock(lock).length > MAX_WORLD_FILES_BYTES) {
    throw new ApiError("bad_request", "The profile and lockfile are over 1 MB together, which is far more than any real profile.");
  }
  return { profile, lock };
}

export async function createWorld(
  env: Pick<Env, "DB" | "BUCKET">,
  o: { name: string; profile: Profile; lock: Lockfile; replace: boolean; imported: boolean; now: number },
): Promise<{ id: string; name: string }> {
  const db = env.DB;
  if (await db.prepare("SELECT 1 FROM worlds WHERE name = ?").bind(o.name).first()) {
    throw new ApiError("conflict", `A world called "${o.name}" already exists. Pick another name with --name.`);
  }
  const current = await activeWorld(db);
  if (current) {
    if (!o.replace) {
      throw new ApiError("conflict", `"${current.name}" is the active world. Add --replace to archive it and start "${o.name}".`);
    }
    const lease = await readLease(db);
    if (isHeld(lease, o.now)) {
      throw new ApiError(
        "lease_held",
        `Someone is hosting "${current.name}" right now. Wait for them to stop, or run "mc-host admin lease release" first.`,
        leaseInfo(lease),
      );
    }
  }
  const id = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [];
  if (current) {
    // Guarded in SQL as well as above: a host may claim between the lease check and this batch.
    stmts.push(
      db.prepare(`UPDATE worlds SET status = 'archived' WHERE id = ?1 AND status = 'active' AND NOT ${LEASE_HELD_SQL}`).bind(current.id, o.now),
    );
    // An expired row still carries its session; clear it so that session can't heartbeat back
    // to life on the archived world.
    stmts.push(db.prepare(`${CLEAR_LEASE} WHERE id = 1 AND NOT ${LEASE_HELD_SQL.replace("?2", "?1")}`).bind(o.now));
  }
  // Only inserts if the archive above went through (or there was no active world).
  stmts.push(
    db
      .prepare(
        `INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at)
         SELECT ?, ?, ?, ?, ?, 'active', ?, ? WHERE NOT EXISTS (SELECT 1 FROM worlds WHERE status = 'active')`,
      )
      .bind(id, o.name, o.lock.minecraft, JSON.stringify(o.profile), serializeLock(o.lock), o.imported ? 1 : 0, o.now),
  );
  const results = await db.batch(stmts);
  if (results.at(-1)!.meta.changes !== 1) {
    const lease = await readLease(db);
    if (isHeld(lease, o.now)) {
      throw new ApiError("lease_held", `Someone started hosting "${current?.name}" just now. Wait for them to stop.`, leaseInfo(lease));
    }
    throw new ApiError("conflict", "The active world changed while creating this one. Try again.");
  }
  if (current) await pruneWorld(env, current.id, 1);
  return { id, name: o.name };
}

/** "worlds/<id>/<rev>-<uuid>.zip" → rev. Unknown shapes are never treated as prunable. */
export function revOfKey(key: string): number {
  const m = /\/(\d+)-[^/]+\.zip$/.exec(key);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((obj) => obj.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * Keep the newest `keep` snapshots. Also delete abandoned uploads, meaning objects with no row
 * whose rev is at or below the latest. Objects above the latest rev may be an upload in flight
 * and are left alone.
 */
export async function pruneWorld(env: Pick<Env, "DB" | "BUCKET">, worldId: string, keep: number): Promise<void> {
  const rows = (
    await env.DB.prepare("SELECT rev, r2_key FROM snapshots WHERE world_id = ? ORDER BY rev DESC")
      .bind(worldId)
      .all<{ rev: number; r2_key: string }>()
  ).results;
  const kept = rows.slice(0, keep);
  const dropped = rows.slice(keep);
  const latestRev = rows[0]?.rev ?? 0;
  const keptKeys = new Set(kept.map((r) => r.r2_key));
  const orphans = (await listKeys(env.BUCKET, `worlds/${worldId}/`)).filter(
    (k) => !keptKeys.has(k) && revOfKey(k) <= latestRev,
  );
  if (dropped.length) {
    await env.DB.prepare("DELETE FROM snapshots WHERE world_id = ? AND rev < ?").bind(worldId, kept.at(-1)!.rev).run();
  }
  // A rollback row reuses an older row's object, so never delete a key a kept row still points at.
  const doomed = [...new Set([...dropped.map((r) => r.r2_key), ...orphans])].filter((k) => !keptKeys.has(k));
  if (doomed.length) await env.BUCKET.delete(doomed);
}

const LEASE_HELD_SQL = "EXISTS (SELECT 1 FROM lease WHERE id = 1 AND holder_id IS NOT NULL AND expires_at >= ?2)";

/** Archive the active world and keep only its last save. Refused while someone is hosting. */
export async function archiveWorld(env: Pick<Env, "DB" | "BUCKET">, worldId: string, now: number): Promise<void> {
  const db = env.DB;
  const [archived] = await db.batch([
    db.prepare(`UPDATE worlds SET status = 'archived' WHERE id = ?1 AND status = 'active' AND NOT ${LEASE_HELD_SQL}`).bind(worldId, now),
    // Same reason as createWorld: an expired session must not heartbeat back onto an archived world.
    db.prepare(`${CLEAR_LEASE} WHERE id = 1 AND NOT ${LEASE_HELD_SQL.replace("?2", "?1")}`).bind(now),
  ]);
  if (archived!.meta.changes !== 1) {
    const lease = await readLease(db);
    if (isHeld(lease, now)) throw new ApiError("lease_held", "Someone is hosting right now. Archive once they stop.", leaseInfo(lease));
    throw new ApiError("conflict", "That world isn't the active one any more.");
  }
  await pruneWorld(env, worldId, 1);
}

/** Point the active world at a new profile and lockfile. The next `mc-host start` builds from them. */
export async function repinWorld(db: D1Database, o: { worldId: string; profile: Profile; lock: Lockfile; now: number }): Promise<void> {
  const r = await db
    .prepare(
      `UPDATE worlds SET profile_json = ?3, lockfile_json = ?4
       WHERE id = ?1 AND status = 'active' AND NOT ${LEASE_HELD_SQL}`,
    )
    .bind(o.worldId, o.now, JSON.stringify(o.profile), serializeLock(o.lock))
    .run();
  if (r.meta.changes !== 1) {
    const lease = await readLease(db);
    if (isHeld(lease, o.now)) throw new ApiError("lease_held", "Someone is hosting right now. Re-pin once they stop.", leaseInfo(lease));
    throw new ApiError("conflict", "That world isn't the active one any more.");
  }
}
