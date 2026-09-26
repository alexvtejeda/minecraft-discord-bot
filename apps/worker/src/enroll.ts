import { hashToken } from "./auth";

export const CODE_MS = 15 * 60_000;
export const DEVICE_WINDOW_MS = 15 * 60_000;
/** 32 characters: digits and capitals without 0/O and 1/I, so a code survives being read aloud. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type Mode = "play" | "host";

export interface EnrollmentRow {
  discord_id: string;
  name: string;
  code_hash: string;
  mode: Mode;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

const dash = (s: string) => `${s.slice(0, 4)}-${s.slice(4)}`;

export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return dash([...bytes].map((b) => ALPHABET[b & 31]).join(""));
}

/** "k7qx p2md", "K7QXP2MD" … → "K7QX-P2MD"; null if it can't be a code. */
export function normalizeCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length !== 8 || [...s].some((ch) => !ALPHABET.includes(ch))) return null;
  return dash(s);
}

/** Store a new code for this person, replacing any code they had, and return it. */
export async function createEnrollment(db: D1Database, o: { discordId: string; name: string; mode: Mode; now: number }): Promise<string> {
  const code = newCode();
  await db
    .prepare(
      `INSERT INTO enrollments (discord_id, name, code_hash, mode, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (discord_id) DO UPDATE SET name = excluded.name, code_hash = excluded.code_hash, mode = excluded.mode,
         created_at = excluded.created_at, expires_at = excluded.expires_at, used_at = NULL`,
    )
    .bind(o.discordId, o.name, await hashToken(code), o.mode, o.now, o.now + CODE_MS)
    .run();
  return code;
}

async function byCode(db: D1Database, raw: string): Promise<EnrollmentRow | null> {
  const code = normalizeCode(raw);
  if (!code) return null;
  return db.prepare("SELECT * FROM enrollments WHERE code_hash = ?").bind(await hashToken(code)).first<EnrollmentRow>();
}

/** A code that hasn't been used and hasn't expired. */
export async function pendingEnrollment(db: D1Database, raw: string, now: number): Promise<EnrollmentRow | null> {
  const row = await byCode(db, raw);
  return row && row.used_at === null && row.expires_at > now ? row : null;
}

/** Mark the code used. False if another redemption got there first or it expired meanwhile. */
export async function consumeEnrollment(db: D1Database, row: EnrollmentRow, now: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE enrollments SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1")
    .bind(now, row.code_hash)
    .run();
  return r.meta.changes === 1;
}

/** A code used within DEVICE_WINDOW_MS, for the installer's device report. */
export async function recentlyUsedEnrollment(db: D1Database, raw: string, now: number): Promise<EnrollmentRow | null> {
  const row = await byCode(db, raw);
  return row && row.used_at !== null && now - row.used_at <= DEVICE_WINDOW_MS ? row : null;
}

/** "mc-" + the username in [a-z0-9-], at most 40 characters in all. */
export function tailnetHostname(name: string, discordId: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 37)
    .replace(/-$/, "");
  return `mc-${s || `player-${discordId.slice(-4)}`}`;
}
