import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { profileHash, sha256Hex, sha512Hex, type LockEntry, type Lockfile, type Side } from "@mc/profile";
import { env } from "cloudflare:workers";
import { strToU8, zipSync } from "fflate";
import { makeProfile } from "../../../packages/profile/test/fakes";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { claimLease, LEASE_MS } from "../src/lease";

export const ADMIN_SECRET = "test-admin";

/** Insert a user directly and return their plaintext token. */
export async function addUser(id = "100000000000000001", name = "Alex"): Promise<string> {
  const token = `token-${id}-0123456789abcdef0123456789`;
  await env.DB.prepare("INSERT INTO users (discord_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, name, await sha256Hex(token), 1)
    .run();
  return token;
}

export function lockEntry(slug: string, side: Side, over: Partial<LockEntry> = {}): LockEntry {
  return {
    slug,
    projectId: slug.toUpperCase(),
    versionId: `${slug}-v1`,
    versionNumber: "1.0.0",
    filename: `${slug}-1.0.0.jar`,
    url: `https://cdn.modrinth.com/data/${slug.toUpperCase()}/versions/${slug}-v1/${slug}-1.0.0.jar`,
    sha1: `sha1-${slug}`,
    sha512: `sha512-${slug}`,
    size: 100,
    side,
    clientOptional: false,
    auto: false,
    prerelease: false,
    ...over,
  };
}

/** A matching profile + lockfile pair for world creation. */
export async function worldFiles(over: Record<string, unknown> = {}, files: LockEntry[] = []) {
  const profile = makeProfile(over);
  const lockfile: Lockfile = {
    lockfileVersion: 1,
    profile: profile.name,
    profileHash: await profileHash(profile),
    minecraft: profile.minecraft,
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files,
  };
  return { profile, lockfile };
}

/** Insert a world row directly (id doubles as its name). */
export async function addWorld(
  id = "w1",
  status: "active" | "archived" = "active",
  files: LockEntry[] = [],
  profileOver: Record<string, unknown> = {},
): Promise<void> {
  const { profile, lockfile } = await worldFiles(profileOver, files);
  await env.DB.prepare(
    "INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at) VALUES (?, ?, '26.3', ?, ?, ?, 0, 1)",
  )
    .bind(id, id, JSON.stringify(profile), JSON.stringify(lockfile), status)
    .run();
}

/** Insert a snapshot row and put its object in R2. */
export async function addSnapshot(worldId: string, rev: number, o: { by?: string; at?: number; data?: string } = {}): Promise<string> {
  const key = `worlds/${worldId}/${rev}-00000000-0000-0000-0000-00000000000${rev % 10}.zip`;
  const data = o.data ?? `rev ${rev}`;
  await env.BUCKET.put(key, data);
  await env.DB.prepare("INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at) VALUES (?, ?, ?, ?, 'x', ?, ?)")
    .bind(worldId, rev, key, data.length, o.by ?? "100000000000000001", o.at ?? rev * 1000)
    .run();
  return key;
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
    MIN_AGENT_VERSION: env.MIN_AGENT_VERSION,
    TS_OAUTH_CLIENT_ID: env.TS_OAUTH_CLIENT_ID,
    TS_OAUTH_CLIENT_SECRET: env.TS_OAUTH_CLIENT_SECRET,
    ...over,
  };
}

export async function call(
  method: string,
  path: string,
  o: { token?: string; admin?: boolean; body?: unknown; env?: Env; agentVersion?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (o.admin) headers.Authorization = `Bearer ${ADMIN_SECRET}`;
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  // Always newer than MIN_AGENT_VERSION unless a test says otherwise.
  const agentVersion = o.agentVersion === undefined ? "999.0.0" : o.agentVersion;
  if (agentVersion !== null) headers["X-MC-Agent-Version"] = agentVersion;
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

/** Claim the lease as if hosting started `sinceMs` ago, with a fresh heartbeat. */
export async function hostSince(userId: string, worldId: string, sinceMs: number, hostAddress = "100.64.0.3") {
  const now = Date.now();
  const lease = await claimLease(env.DB, { userId, hostAddress, worldId, now: now - sinceMs });
  await env.DB.prepare("UPDATE lease SET expires_at = ? WHERE id = 1").bind(now + LEASE_MS).run();
  return lease;
}

/** A minimal Fabric mod jar. */
export function fabricJar(o: Record<string, unknown> = {}): Uint8Array {
  const meta = { schemaVersion: 1, id: "dragonbond", version: "1.1.1", depends: { minecraft: "=26.3", java: ">=25", citadel: "*" }, ...o };
  return zipSync({ "fabric.mod.json": strToU8(JSON.stringify(meta)) });
}

export async function putJar(bytes: Uint8Array, q: { sha512?: string; filename?: string; minecraft?: string; java?: string } = {}, auth = `Bearer ${ADMIN_SECRET}`) {
  const sha512 = q.sha512 ?? (await sha512Hex(bytes));
  const params = new URLSearchParams({ filename: q.filename ?? "deeper end.jar", minecraft: q.minecraft ?? "26.3", java: q.java ?? "25" });
  const ctx = createExecutionContext();
  const res = await app.request(`/admin/jars/${sha512}?${params}`, { method: "PUT", headers: { Authorization: auth }, body: bytes }, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as any, sha512 };
}
