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
