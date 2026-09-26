import type { LeaseInfo } from "@mc/protocol";
import { ApiError } from "./errors";

export const LEASE_MS = 10 * 60_000;

export interface LeaseRow {
  holder_id: string | null;
  holder_name: string | null;
  session_id: string | null;
  world_id: string | null;
  base_rev: number | null;
  host_address: string | null;
  claimed_at: number | null;
  expires_at: number | null;
}

export const CLEAR_LEASE =
  "UPDATE lease SET holder_id = NULL, session_id = NULL, world_id = NULL, base_rev = NULL, host_address = NULL, claimed_at = NULL, expires_at = NULL";

export function leaseLostError(): ApiError {
  return new ApiError(
    "lease_lost",
    "This hosting session is no longer valid: someone else claimed the lease, or a maintainer released it.",
  );
}

export async function readLease(db: D1Database): Promise<LeaseRow> {
  const row = await db
    .prepare(
      `SELECT l.holder_id, u.name AS holder_name, l.session_id, l.world_id, l.base_rev, l.host_address, l.claimed_at, l.expires_at
       FROM lease l LEFT JOIN users u ON u.discord_id = l.holder_id WHERE l.id = 1`,
    )
    .first<LeaseRow>();
  if (!row) throw new Error("The lease row is missing. Apply the D1 migrations.");
  return row;
}

export function isHeld(l: LeaseRow, now: number): boolean {
  return l.holder_id !== null && (l.expires_at ?? 0) >= now;
}

export function leaseInfo(l: LeaseRow): LeaseInfo {
  return {
    name: l.holder_name ?? "Someone",
    hostAddress: l.host_address ?? "an unknown address",
    claimedAt: l.claimed_at ?? 0,
    expiresAt: l.expires_at ?? 0,
  };
}

/** One conditional UPDATE, so two simultaneous claims can't both win. */
export async function claimLease(
  db: D1Database,
  o: { userId: string; hostAddress: string; worldId: string; now: number },
): Promise<{ sessionId: string; baseRev: number; expiresAt: number }> {
  const row = await db
    .prepare(
      `UPDATE lease SET holder_id = ?1, session_id = ?2, world_id = ?3,
         base_rev = (SELECT COALESCE(MAX(rev), 0) FROM snapshots WHERE world_id = ?3),
         host_address = ?4, claimed_at = ?5, expires_at = ?6
       WHERE id = 1 AND (holder_id IS NULL OR expires_at < ?5 OR holder_id = ?1)
       RETURNING session_id, base_rev, expires_at`,
    )
    .bind(o.userId, crypto.randomUUID(), o.worldId, o.hostAddress, o.now, o.now + LEASE_MS)
    .first<{ session_id: string; base_rev: number; expires_at: number }>();
  if (row) return { sessionId: row.session_id, baseRev: row.base_rev, expiresAt: row.expires_at };
  const l = await readLease(db);
  throw new ApiError("lease_held", `${l.holder_name ?? "Someone"} is already hosting at ${l.host_address}.`, leaseInfo(l));
}

export async function heartbeatLease(db: D1Database, sessionId: string, now: number): Promise<number> {
  const r = await db.prepare("UPDATE lease SET expires_at = ?1 WHERE id = 1 AND session_id = ?2").bind(now + LEASE_MS, sessionId).run();
  if (r.meta.changes !== 1) throw leaseLostError();
  return now + LEASE_MS;
}

export async function releaseLease(db: D1Database, sessionId: string): Promise<void> {
  const r = await db.prepare(`${CLEAR_LEASE} WHERE id = 1 AND session_id = ?`).bind(sessionId).run();
  if (r.meta.changes !== 1) throw leaseLostError();
}

/** Maintainer override for a stuck lease. Returns who held it, or null if nobody did. */
export async function forceRelease(db: D1Database, now: number): Promise<LeaseInfo | null> {
  const l = await readLease(db);
  await db.prepare(`${CLEAR_LEASE} WHERE id = 1`).run();
  return isHeld(l, now) ? leaseInfo(l) : null;
}

export async function requireSession(db: D1Database, sessionId: string): Promise<LeaseRow & { world_id: string }> {
  const l = await readLease(db);
  if (!l.holder_id || l.session_id !== sessionId || !l.world_id) throw leaseLostError();
  return l as LeaseRow & { world_id: string };
}
