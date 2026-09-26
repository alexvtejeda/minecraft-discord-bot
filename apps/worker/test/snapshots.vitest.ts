import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { readLease } from "../src/lease";
import { commitSnapshot } from "../src/snapshots";
import { addUser, call, envWith, worldFiles } from "./helpers";

let alex: string;
let worldId: string;
const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(async () => {
  alex = await addUser("100000000000000001", "Alex");
  const { profile, lockfile } = await worldFiles();
  worldId = (await call("POST", "/admin/worlds", { admin: true, body: { name: "w", profile, lockfile } })).body.id;
});

async function claim(): Promise<string> {
  return (await call("POST", "/agent/lease/claim", { token: alex, body: { hostAddress: "100.64.0.3" } })).body.sessionId;
}

/** upload-url → PUT through the dev proxy → commit. Returns the commit response. */
async function save(sessionId: string, baseRev: number, data: Uint8Array, extra: Record<string, unknown> = {}) {
  const sha256 = await hex(data);
  const target = await call("POST", "/agent/snapshot/upload-url", { token: alex, body: { sessionId, baseRev, size: data.length, sha256 } });
  expect(target.status).toBe(200);
  const put = await app.request(target.body.url, { method: "PUT", headers: target.body.headers, body: data }, env);
  expect(put.status).toBe(200);
  return call("POST", "/agent/snapshot/commit", {
    token: alex,
    body: { sessionId, rev: target.body.rev, key: target.body.key, size: data.length, sha256, ...extra },
  });
}

describe("upload and commit", () => {
  it("commits rev 1 and serves it through the manifest", async () => {
    const s = await claim();
    const r = await save(s, 0, bytes("rev one"));
    expect(r.body).toEqual({ rev: 1 });
    expect((await readLease(env.DB)).base_rev).toBe(1);
    const m = await call("GET", "/agent/manifest", { token: alex });
    expect(m.body.latest).toMatchObject({ rev: 1, size: 7, sha256: await hex(bytes("rev one")) });
    const got = await app.request(m.body.latest.url, {}, env);
    expect(await got.text()).toBe("rev one");
  });

  it("refuses an upload URL for a stale base rev", async () => {
    const s = await claim();
    await save(s, 0, bytes("a"));
    const r = await call("POST", "/agent/snapshot/upload-url", {
      token: alex,
      body: { sessionId: s, baseRev: 0, size: 1, sha256: "a".repeat(64) },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("stale_rev");
  });

  it("refuses a commit whose rev skips ahead", async () => {
    const s = await claim();
    const data = bytes("x");
    const key = `worlds/${worldId}/2-skip.zip`;
    await env.BUCKET.put(key, data);
    const r = await call("POST", "/agent/snapshot/commit", {
      token: alex,
      body: { sessionId: s, rev: 2, key, size: 1, sha256: await hex(data) },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("stale_rev");
  });

  it("refuses a commit when the object is missing, short, or not this world's", async () => {
    const s = await claim();
    const sha = "c".repeat(64);
    const missing = await call("POST", "/agent/snapshot/commit", {
      token: alex,
      body: { sessionId: s, rev: 1, key: `worlds/${worldId}/1-none.zip`, size: 5, sha256: sha },
    });
    expect(missing.body.error).toBe("upload_missing");
    await env.BUCKET.put(`worlds/${worldId}/1-short.zip`, "abc");
    const short = await call("POST", "/agent/snapshot/commit", {
      token: alex,
      body: { sessionId: s, rev: 1, key: `worlds/${worldId}/1-short.zip`, size: 5, sha256: sha },
    });
    expect(short.body.error).toBe("upload_missing");
    const foreign = await call("POST", "/agent/snapshot/commit", {
      token: alex,
      body: { sessionId: s, rev: 1, key: "worlds/other/1-x.zip", size: 5, sha256: sha },
    });
    expect(foreign.status).toBe(400);
  });

  it("refuses a stale session", async () => {
    const s = await claim();
    await call("POST", "/admin/lease/release", { admin: true });
    const r = await call("POST", "/agent/snapshot/upload-url", {
      token: alex,
      body: { sessionId: s, baseRev: 0, size: 1, sha256: "a".repeat(64) },
    });
    expect(r.body.error).toBe("lease_lost");
  });

  it("records pre-generation when reported", async () => {
    const s = await claim();
    await save(s, 0, bytes("a"), { pregenDone: true });
    const row = await env.DB.prepare("SELECT pregen_done FROM worlds WHERE id = ?").bind(worldId).first<{ pregen_done: number }>();
    expect(row?.pregen_done).toBe(1);
  });
});

describe("retention", () => {
  it("keeps the newest 5 snapshots and removes abandoned uploads, but not in-flight ones", async () => {
    const s = await claim();
    await save(s, 0, bytes("1"));
    await save(s, 1, bytes("2"));
    await env.BUCKET.put(`worlds/${worldId}/1-orphan.zip`, "o");
    await env.BUCKET.put(`worlds/${worldId}/9-inflight.zip`, "f");
    for (let rev = 2; rev < 7; rev++) await save(s, rev, bytes(String(rev + 1)));
    const revs = await env.DB.prepare("SELECT rev FROM snapshots WHERE world_id = ? ORDER BY rev").bind(worldId).all<{ rev: number }>();
    expect(revs.results.map((r) => r.rev)).toEqual([3, 4, 5, 6, 7]);
    const keys = (await env.BUCKET.list({ prefix: `worlds/${worldId}/` })).objects.map((o) => o.key);
    expect(keys).toHaveLength(6);
    expect(keys).toContain(`worlds/${worldId}/9-inflight.zip`);
    expect(keys).not.toContain(`worlds/${worldId}/1-orphan.zip`);
  });
});

describe("import", () => {
  async function importData(data: Uint8Array) {
    const sha256 = await hex(data);
    const t = await call("POST", `/admin/worlds/${worldId}/import-url`, { admin: true, body: { size: data.length, sha256 } });
    if (t.status !== 200) return t;
    await app.request(t.body.url, { method: "PUT", headers: t.body.headers, body: data }, env);
    return call("POST", `/admin/worlds/${worldId}/import-commit`, {
      admin: true,
      body: { key: t.body.key, size: data.length, sha256 },
    });
  }

  it("imports a zip as rev 1, once", async () => {
    expect((await importData(bytes("old world"))).body).toEqual({ rev: 1 });
    const again = await importData(bytes("again"));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("conflict");
  });

  it("refuses to import while someone hosts", async () => {
    await claim();
    const r = await importData(bytes("x"));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("lease_held");
  });
});

describe("commit retries", () => {
  async function uploaded(s: string, data: Uint8Array) {
    const sha256 = await hex(data);
    const t = await call("POST", "/agent/snapshot/upload-url", { token: alex, body: { sessionId: s, baseRev: 0, size: data.length, sha256 } });
    await app.request(t.body.url, { method: "PUT", headers: t.body.headers, body: data }, env);
    return { sessionId: s, rev: t.body.rev as number, key: t.body.key as string, size: data.length, sha256 };
  }

  it("a retried commit that already landed answers ok instead of stale_rev", async () => {
    const body = await uploaded(await claim(), bytes("once"));
    expect((await call("POST", "/agent/snapshot/commit", { token: alex, body })).body).toEqual({ rev: 1 });
    const again = await call("POST", "/agent/snapshot/commit", { token: alex, body });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ rev: 1 });
  });

  it("a failing prune doesn't turn a landed commit into an error", async () => {
    const body = await uploaded(await claim(), bytes("x"));
    const bucket = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop === "list") return async () => {
          throw new Error("R2 list failed");
        };
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await commitSnapshot(envWith({ BUCKET: bucket }), { ...body, worldId, uploadedBy: "x", now: 1 });
    expect((await readLease(env.DB)).base_rev).toBe(1);
  });
});
