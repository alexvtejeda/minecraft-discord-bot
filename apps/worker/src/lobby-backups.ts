import type { UploadTarget } from "@mc/protocol";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { readSlot, requireSlotSession, slotLostError } from "./lobby";
import { verifyUpload } from "./snapshots";
import { storageFor } from "./storage";
import { revOfKey } from "./worlds";

export const KEEP_LOBBY_BACKUPS = 3;

export interface LobbyBackupRow {
  rev: number;
  r2_key: string;
  size: number;
  sha256: string;
  created_at: number;
}

export const lobbyBackupKey = (rev: number) => `lobby/${rev}-${crypto.randomUUID()}.zip`;

export const latestBackup = (db: D1Database) =>
  db.prepare("SELECT * FROM lobby_backups ORDER BY rev DESC LIMIT 1").first<LobbyBackupRow>();

export async function beginLobbyUpload(env: Env, requestUrl: string, o: { sessionId: string; sha256: string }): Promise<UploadTarget> {
  await requireSlotSession(env.DB, o.sessionId);
  const rev = ((await latestBackup(env.DB))?.rev ?? 0) + 1;
  const key = lobbyBackupKey(rev);
  return { rev, key, ...(await storageFor(env, requestUrl).putTarget(key, o.sha256)) };
}

/** Only the slot's current session may commit, and only as latest + 1, so two lobbies can't interleave backups. */
export async function commitLobbyBackup(
  env: Env,
  o: { sessionId: string; rev: number; key: string; size: number; sha256: string; now: number },
): Promise<void> {
  await verifyUpload(env.BUCKET, { prefix: `lobby/${o.rev}-`, key: o.key, size: o.size, sha256: o.sha256 }, "That upload key doesn't belong to this lobby backup.");
  const r = await env.DB.prepare(
    `INSERT INTO lobby_backups (rev, r2_key, size, sha256, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE EXISTS (SELECT 1 FROM lobby_slot WHERE id = 1 AND session_id = ?6)
       AND (SELECT COALESCE(MAX(rev), 0) FROM lobby_backups) = ?1 - 1`,
  )
    .bind(o.rev, o.key, o.size, o.sha256, o.now, o.sessionId)
    .run();
  if (r.meta.changes !== 1) {
    // A retry of a commit that already landed (its reply was lost) is not an error.
    const landed = await env.DB.prepare("SELECT 1 FROM lobby_backups WHERE rev = ? AND r2_key = ?").bind(o.rev, o.key).first();
    if (!landed) {
      if ((await readSlot(env.DB)).session_id !== o.sessionId) throw slotLostError();
      throw new ApiError("stale_rev", `Lobby backup ${o.rev} can't be committed because a newer backup exists.`);
    }
  }
  // Best effort: the commit has landed, so a failed cleanup must not turn it into an error.
  try {
    await pruneLobbyBackups(env, KEEP_LOBBY_BACKUPS);
  } catch (err) {
    console.error("pruning lobby backups failed", err);
  }
}

/** Keep the newest `keep` backups, and delete abandoned uploads at or below the latest rev. */
export async function pruneLobbyBackups(env: Pick<Env, "DB" | "BUCKET">, keep: number): Promise<void> {
  const rows = (await env.DB.prepare("SELECT rev, r2_key FROM lobby_backups ORDER BY rev DESC").all<{ rev: number; r2_key: string }>()).results;
  const dropped = rows.slice(keep);
  const kept = new Set(rows.slice(0, keep).map((r) => r.r2_key));
  const latestRev = rows[0]?.rev ?? 0;
  // A handful of backups plus the odd abandoned upload: always one page.
  const listed = await env.BUCKET.list({ prefix: "lobby/" });
  const doomed = listed.objects.map((o) => o.key).filter((k) => !kept.has(k) && revOfKey(k) <= latestRev);
  if (dropped.length) await env.DB.prepare("DELETE FROM lobby_backups WHERE rev <= ?").bind(dropped[0]!.rev).run();
  if (doomed.length) await env.BUCKET.delete(doomed);
}
