import type { LobbyHost } from "@mc/protocol";
import { ago } from "./discord/format";
import { ApiError } from "./errors";
import { isHeld, readLease } from "./lease";
import { activeWorld } from "./worlds";

/** The lobby polls every 5 s; two minutes of silence means it's gone. */
export const LOBBY_MS = 2 * 60_000;
/** The lobby's tailnet name, set in infra/docker/lobby-compose.yml. */
export const LOBBY_NAME = "mc-lobby";

export interface LobbySlotRow {
  holder_id: string | null;
  machine: string | null;
  session_id: string | null;
  address: string | null;
  claimed_at: number | null;
  expires_at: number | null;
}

const CLEAR_SLOT =
  "UPDATE lobby_slot SET holder_id = NULL, machine = NULL, session_id = NULL, address = NULL, claimed_at = NULL, expires_at = NULL";

export function slotLostError(): ApiError {
  return new ApiError("lease_lost", "This lobby session is no longer valid: another lobby took over, or a maintainer released it.");
}

export async function readSlot(db: D1Database): Promise<LobbySlotRow> {
  const row = await db
    .prepare("SELECT holder_id, machine, session_id, address, claimed_at, expires_at FROM lobby_slot WHERE id = 1")
    .first<LobbySlotRow>();
  if (!row) throw new Error("The lobby_slot row is missing. Apply the D1 migrations.");
  return row;
}

export const isUp = (s: LobbySlotRow, now: number): boolean => s.holder_id !== null && (s.expires_at ?? 0) >= now;

/** One conditional UPDATE: the slot is free, expired, or held by this machine's previous session. */
export async function claimSlot(
  db: D1Database,
  o: { userId: string; machine: string; address: string; previousSessionId?: string; now: number },
): Promise<{ sessionId: string; expiresAt: number }> {
  const row = await db
    .prepare(
      `UPDATE lobby_slot SET holder_id = ?1, machine = ?2, session_id = ?3, address = ?4, claimed_at = ?5, expires_at = ?6
       WHERE id = 1 AND (holder_id IS NULL OR expires_at < ?5 OR session_id = ?7)
       RETURNING session_id, expires_at`,
    )
    .bind(o.userId, o.machine, crypto.randomUUID(), o.address, o.now, o.now + LOBBY_MS, o.previousSessionId ?? null)
    .first<{ session_id: string; expires_at: number }>();
  if (row) return { sessionId: row.session_id, expiresAt: row.expires_at };
  const s = await readSlot(db);
  const heard = ago(o.now - ((s.expires_at ?? o.now) - LOBBY_MS));
  throw new ApiError(
    "lease_held",
    `The lobby is already running on ${s.machine ?? "another machine"} (heard from it ${heard}). Stop it there first, or run \`mc-host admin lobby release\`.`,
  );
}

export async function pollSlot(db: D1Database, sessionId: string, now: number): Promise<number> {
  const r = await db.prepare("UPDATE lobby_slot SET expires_at = ?1 WHERE id = 1 AND session_id = ?2").bind(now + LOBBY_MS, sessionId).run();
  if (r.meta.changes !== 1) throw slotLostError();
  return now + LOBBY_MS;
}

export async function releaseSlot(db: D1Database, sessionId: string): Promise<void> {
  const r = await db.prepare(`${CLEAR_SLOT} WHERE id = 1 AND session_id = ?`).bind(sessionId).run();
  if (r.meta.changes !== 1) throw slotLostError();
}

/** Maintainer override for a lobby machine that died. Returns who held it, or null if nobody did. */
export async function forceReleaseSlot(db: D1Database, now: number): Promise<{ machine: string; address: string } | null> {
  const s = await readSlot(db);
  await db.prepare(`${CLEAR_SLOT} WHERE id = 1`).run();
  return isUp(s, now) ? { machine: s.machine ?? "an unknown machine", address: s.address ?? "an unknown address" } : null;
}

export async function requireSlotSession(db: D1Database, sessionId: string): Promise<void> {
  const s = await readSlot(db);
  if (!s.holder_id || s.session_id !== sessionId) throw slotLostError();
}

/** Who the lobby should send players to: the holder of a live lease on the active world. */
export async function lobbyHost(db: D1Database, now: number): Promise<LobbyHost | null> {
  const [lease, world] = await Promise.all([readLease(db), activeWorld(db)]);
  if (!world || !isHeld(lease, now) || lease.world_id !== world.id || !lease.host_address) return null;
  return { name: lease.holder_name ?? "Someone", address: lease.host_address, world: world.name, minecraft: world.mc_version };
}

export async function lobbyAddress(db: D1Database, now: number): Promise<{ address: string } | null> {
  const s = await readSlot(db);
  return isUp(s, now) && s.address ? { address: s.address } : null;
}
