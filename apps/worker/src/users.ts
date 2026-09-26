import { hashToken } from "./auth";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Create or update the user and return a fresh token. Only its hash is stored. */
export async function mintToken(db: D1Database, discordId: string, name: string, now: number): Promise<string> {
  const token = randomToken();
  await db
    .prepare(
      `INSERT INTO users (discord_id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (discord_id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, revoked_at = NULL`,
    )
    .bind(discordId, name, await hashToken(token), now)
    .run();
  return token;
}

export async function listUsers(db: D1Database): Promise<{ discordId: string; name: string; revoked: boolean }[]> {
  const rows = await db
    .prepare("SELECT discord_id, name, revoked_at FROM users ORDER BY name")
    .all<{ discord_id: string; name: string; revoked_at: number | null }>();
  return rows.results.map((r) => ({ discordId: r.discord_id, name: r.name, revoked: r.revoked_at !== null }));
}

/** Someone who only plays still gets a row, so revoking works the same for everyone. Its token is never shown, so it can't host. */
export async function ensurePlayer(db: D1Database, discordId: string, name: string, now: number): Promise<void> {
  await db
    .prepare("INSERT INTO users (discord_id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (discord_id) DO NOTHING")
    .bind(discordId, name, await hashToken(randomToken()), now)
    .run();
}

/** Block their token and future /setup. `mc-host admin token mint` clears it again. */
export async function revokeUser(db: D1Database, discordId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (discord_id, name, token_hash, created_at, revoked_at) VALUES (?1, '(never set up)', ?2, ?3, ?3)
       ON CONFLICT (discord_id) DO UPDATE SET revoked_at = excluded.revoked_at`,
    )
    .bind(discordId, await hashToken(randomToken()), now)
    .run();
}

export async function isRevoked(db: D1Database, discordId: string): Promise<boolean> {
  const row = await db.prepare("SELECT revoked_at FROM users WHERE discord_id = ?").bind(discordId).first<{ revoked_at: number | null }>();
  return !!row && row.revoked_at !== null;
}
