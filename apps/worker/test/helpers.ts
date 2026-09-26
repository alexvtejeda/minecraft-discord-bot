import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { profileHash, sha256Hex, type Lockfile } from "@mc/profile";
import { env } from "cloudflare:workers";
import { makeProfile } from "../../../packages/profile/test/fakes";
import type { Env } from "../src/env";
import { app } from "../src/index";

export const ADMIN_SECRET = "test-admin";

/** Insert a user directly and return their plaintext token. */
export async function addUser(id = "100000000000000001", name = "Alex"): Promise<string> {
  const token = `token-${id}-0123456789abcdef0123456789`;
  await env.DB.prepare("INSERT INTO users (discord_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, name, await sha256Hex(token), 1)
    .run();
  return token;
}

/** A matching profile + lockfile pair (no mod files) for world creation. */
export async function worldFiles(over: Record<string, unknown> = {}) {
  const profile = makeProfile(over);
  const lockfile: Lockfile = {
    lockfileVersion: 1,
    profile: profile.name,
    profileHash: await profileHash(profile),
    minecraft: profile.minecraft,
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files: [],
  };
  return { profile, lockfile };
}

/** Insert a world row directly (id doubles as its name). */
export async function addWorld(id = "w1", status: "active" | "archived" = "active"): Promise<void> {
  const { profile, lockfile } = await worldFiles();
  await env.DB.prepare(
    "INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at) VALUES (?, ?, '26.3', ?, ?, ?, 0, 1)",
  )
    .bind(id, id, JSON.stringify(profile), JSON.stringify(lockfile), status)
    .run();
}

export function envWith(over: Partial<Env>): Env {
  return {
    DB: env.DB,
    BUCKET: env.BUCKET,
    ADMIN_SECRET: env.ADMIN_SECRET,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_BUCKET_NAME: env.R2_BUCKET_NAME,
    DEV_R2_PROXY: env.DEV_R2_PROXY,
    DISCORD_APP_ID: env.DISCORD_APP_ID,
    DISCORD_PUBLIC_KEY: env.DISCORD_PUBLIC_KEY,
    DISCORD_GUILD_ID: env.DISCORD_GUILD_ID,
    ANNOUNCE_CHANNEL_ID: env.ANNOUNCE_CHANNEL_ID,
    MAINTAINER_ROLE_ID: env.MAINTAINER_ROLE_ID,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    ...over,
  };
}

export async function call(
  method: string,
  path: string,
  o: { token?: string; admin?: boolean; body?: unknown; env?: Env } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (o.admin) headers.Authorization = `Bearer ${ADMIN_SECRET}`;
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const ctx = createExecutionContext();
  const res = await app.request(path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, o.env ?? env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}
