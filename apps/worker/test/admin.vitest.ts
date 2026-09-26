import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/auth";
import { claimLease, heartbeatLease, LEASE_MS } from "../src/lease";
import { addUser, call, worldFiles } from "./helpers";

async function createWorld(name: string, extra: Record<string, unknown> = {}) {
  const { profile, lockfile } = await worldFiles();
  return call("POST", "/admin/worlds", { admin: true, body: { name, profile, lockfile, ...extra } });
}
const worldRow = (name: string) =>
  env.DB.prepare("SELECT * FROM worlds WHERE name = ?").bind(name).first<{ id: string; status: string; pregen_done: number }>();

describe("POST /admin/worlds", () => {
  it("creates the active world from a matching profile and lockfile", async () => {
    const r = await createWorld("adventure-1");
    expect(r.status).toBe(201);
    expect(r.body.name).toBe("adventure-1");
    expect((await worldRow("adventure-1"))?.status).toBe("active");
    expect((await worldRow("adventure-1"))?.pregen_done).toBe(0);
  });

  it("marks imported worlds as already pre-generated", async () => {
    await createWorld("imported-1", { imported: true });
    expect((await worldRow("imported-1"))?.pregen_done).toBe(1);
  });

  it("rejects a lockfile that doesn't match the profile", async () => {
    const { profile, lockfile } = await worldFiles();
    const r = await call("POST", "/admin/worlds", {
      admin: true,
      body: { name: "w", profile, lockfile: { ...lockfile, profileHash: "0".repeat(64) } },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("doesn't match");
  });

  it("refuses a second active world without --replace, and duplicate names", async () => {
    await createWorld("first");
    const second = await createWorld("second");
    expect(second.status).toBe(409);
    expect(second.body.message).toContain("--replace");
    const dup = await createWorld("first", { replace: true });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toContain("already exists");
  });

  it("--replace archives the old world down to its latest snapshot", async () => {
    await createWorld("old");
    const old = (await worldRow("old"))!;
    for (const rev of [1, 2, 3]) {
      const key = `worlds/${old.id}/${rev}-x.zip`;
      await env.BUCKET.put(key, "zip");
      await env.DB.prepare("INSERT INTO snapshots VALUES (?, ?, ?, 3, 'x', 'a', ?)").bind(old.id, rev, key, rev).run();
    }
    const r = await createWorld("new", { replace: true });
    expect(r.status).toBe(201);
    expect((await worldRow("old"))?.status).toBe("archived");
    expect((await worldRow("new"))?.status).toBe("active");
    const revs = await env.DB.prepare("SELECT rev FROM snapshots WHERE world_id = ?").bind(old.id).all<{ rev: number }>();
    expect(revs.results.map((x) => x.rev)).toEqual([3]);
    const listed = await env.BUCKET.list({ prefix: `worlds/${old.id}/` });
    expect(listed.objects.map((o) => o.key)).toEqual([`worlds/${old.id}/3-x.zip`]);
  });

  it("--replace clears an expired lease, so its old session can't come back", async () => {
    await createWorld("stale");
    await addUser("100000000000000001", "Alex");
    const old = await claimLease(env.DB, {
      userId: "100000000000000001",
      hostAddress: "100.64.0.3",
      worldId: (await worldRow("stale"))!.id,
      now: Date.now() - 2 * LEASE_MS,
    });
    expect((await createWorld("fresh", { replace: true })).status).toBe(201);
    await expect(heartbeatLease(env.DB, old.sessionId, Date.now())).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("--replace fails while someone holds the lease", async () => {
    await createWorld("busy");
    await addUser("100000000000000001", "Alex");
    await claimLease(env.DB, { userId: "100000000000000001", hostAddress: "100.64.0.3", worldId: (await worldRow("busy"))!.id, now: Date.now() });
    const r = await createWorld("next", { replace: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("lease_held");
    expect(await worldRow("next")).toBeNull();
  });

  it("needs the admin secret", async () => {
    const token = await addUser();
    const { profile, lockfile } = await worldFiles();
    const r = await call("POST", "/admin/worlds", { token, body: { name: "x", profile, lockfile } });
    expect(r.status).toBe(401);
  });
});

describe("tokens, lease release and status", () => {
  it("mints a token that is stored only as a hash, and re-minting replaces it", async () => {
    const a = await call("POST", "/admin/tokens", { admin: true, body: { discordId: "123456789012345678", name: "Sam" } });
    expect(a.status).toBe(201);
    const row = () => env.DB.prepare("SELECT token_hash FROM users WHERE discord_id = '123456789012345678'").first<{ token_hash: string }>();
    expect((await row())?.token_hash).toBe(await hashToken(a.body.token));
    const b = await call("POST", "/admin/tokens", { admin: true, body: { discordId: "123456789012345678", name: "Sam" } });
    expect(b.body.token).not.toBe(a.body.token);
    expect((await row())?.token_hash).toBe(await hashToken(b.body.token));
  });

  it("releases a held lease and reports who had it", async () => {
    await createWorld("w");
    await addUser("100000000000000001", "Alex");
    await claimLease(env.DB, { userId: "100000000000000001", hostAddress: "100.64.0.3", worldId: (await worldRow("w"))!.id, now: Date.now() });
    const r = await call("POST", "/admin/lease/release", { admin: true });
    expect(r.body.released).toMatchObject({ name: "Alex", hostAddress: "100.64.0.3" });
    expect((await call("POST", "/admin/lease/release", { admin: true })).body.released).toBeNull();
  });

  it("reports the active world, lease and users", async () => {
    await createWorld("w");
    await addUser("100000000000000001", "Alex");
    const r = await call("GET", "/admin/status", { admin: true });
    expect(r.status).toBe(200);
    expect(r.body.world).toMatchObject({ name: "w", minecraft: "26.3", latestRev: 0, latestAt: null, pregenDone: false });
    expect(r.body.lease).toBeNull();
    expect(r.body.users).toEqual([{ discordId: "100000000000000001", name: "Alex", revoked: false }]);
  });
});
