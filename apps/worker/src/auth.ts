import { sha256Hex } from "@mc/profile";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env";
import { ApiError } from "./errors";

export const hashToken = (token: string): Promise<string> => sha256Hex(token);

function bearer(header: string | undefined): string | null {
  const m = /^Bearer (\S+)$/.exec(header ?? "");
  return m ? m[1]! : null;
}

const rejected = () => new ApiError("unauthorized", "Your token was rejected. Ask a maintainer for a new one.");

export const agentAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (!token) throw rejected();
  const row = await c.env.DB.prepare("SELECT discord_id, name FROM users WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await hashToken(token))
    .first<{ discord_id: string; name: string }>();
  if (!row) throw rejected();
  c.set("userId", row.discord_id);
  c.set("userName", row.name);
  await next();
});

/** Compare hashes so the comparison takes the same time whatever the input. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (!token || !c.env.ADMIN_SECRET || !(await sameSecret(token, c.env.ADMIN_SECRET))) {
    throw new ApiError("unauthorized", "The admin secret was rejected. Check MC_ADMIN_SECRET.");
  }
  await next();
});
