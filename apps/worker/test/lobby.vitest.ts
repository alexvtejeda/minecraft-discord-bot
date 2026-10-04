import { sha256Hex } from "@mc/profile";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { LOBBY_MS } from "../src/lobby";
import { addLobby, addUser, addWorld, call, hostSince } from "./helpers";

const ALEX = "100000000000000001";
let alex: string;
let lobby: string;
beforeEach(async () => {
  alex = await addUser(ALEX, "Alex");
  lobby = await addLobby("fedora");
});

describe("lobby tokens", () => {
  it("a lobby token can't use the hosting API", async () => {
    expect((await call("GET", "/agent/manifest", { token: lobby })).status).toBe(401);
  });

  it("the admin mints a lobby token, and minting again replaces it", async () => {
    const first = await call("POST", "/admin/lobby/token", { admin: true, body: { name: "pi" } });
    expect(first.status).toBe(201);
    expect(await env.DB.prepare("SELECT name, scope FROM users WHERE discord_id = 'lobby-pi'").first()).toEqual({ name: "lobby pi", scope: "lobby" });
    const second = await call("POST", "/admin/lobby/token", { admin: true, body: { name: "pi" } });
    expect(second.body.token).not.toBe(first.body.token);
    expect(await env.DB.prepare("SELECT token_hash FROM users WHERE discord_id = 'lobby-pi'").first("token_hash")).toBe(await sha256Hex(second.body.token));
  });

  it("refuses a lobby name that isn't a slug", async () => {
    expect((await call("POST", "/admin/lobby/token", { admin: true, body: { name: "My Pi" } })).status).toBe(400);
  });
});

const claimAs = (o: { machine?: string; previousSessionId?: string; token?: string } = {}) =>
  call("POST", "/lobby/claim", {
    token: o.token ?? lobby,
    body: { address: "100.64.0.50", machine: o.machine ?? "fedora", ...(o.previousSessionId ? { previousSessionId: o.previousSessionId } : {}) },
  });
const poll = (sessionId: string) => call("POST", "/lobby/poll", { token: lobby, body: { sessionId } });

describe("the lobby slot", () => {
  it("claims a free slot and polls with nobody hosting", async () => {
    const c = await claimAs();
    expect(c.status).toBe(200);
    const p = await poll(c.body.sessionId);
    expect(p.body.host).toBeNull();
    expect(p.body.expiresAt).toBeGreaterThan(Date.now() + LOBBY_MS - 10_000);
  });

  it("refuses a second machine while the first is up, naming it", async () => {
    await claimAs();
    const r = await claimAs({ machine: "pi" });
    expect(r.status).toBe(409);
    expect(r.body.message).toBe(
      "The lobby is already running on fedora (heard from it just now). Stop it there first, or run `mc-host admin lobby release`.",
    );
  });

  it("lets the same machine take its slot back after a restart, ending the old session", async () => {
    const first = await claimAs();
    const again = await claimAs({ previousSessionId: first.body.sessionId });
    expect(again.status).toBe(200);
    expect(again.body.sessionId).not.toBe(first.body.sessionId);
    expect((await poll(first.body.sessionId)).body.error).toBe("lease_lost");
  });

  it("lets any machine take an expired slot", async () => {
    await claimAs();
    await env.DB.prepare("UPDATE lobby_slot SET expires_at = ? WHERE id = 1").bind(Date.now() - 1).run();
    expect((await claimAs({ machine: "pi" })).status).toBe(200);
  });

  it("poll shows who is hosting the active world", async () => {
    await addWorld("w1");
    await hostSince(ALEX, "w1", 60_000);
    const c = await claimAs();
    expect((await poll(c.body.sessionId)).body.host).toEqual({ name: "Alex", address: "100.64.0.3", world: "w1", minecraft: "26.3" });
  });

  it("release frees the slot, and the admin can force it", async () => {
    const c = await claimAs();
    expect((await call("POST", "/lobby/release", { token: lobby, body: { sessionId: c.body.sessionId } })).body).toEqual({ ok: true });
    await claimAs({ machine: "pi" });
    expect((await call("POST", "/admin/lobby/release", { admin: true })).body).toEqual({ released: { machine: "pi", address: "100.64.0.50" } });
    expect((await call("POST", "/admin/lobby/release", { admin: true })).body).toEqual({ released: null });
  });

  it("a hosting token can't use the lobby API", async () => {
    expect((await claimAs({ token: alex })).status).toBe(401);
  });
});

/** upload-url, then PUT through the dev R2 proxy. Commit is left to the test. */
async function backup(sessionId: string, data: string, baseRev = 0) {
  const sha256 = await sha256Hex(data);
  const t = await call("POST", "/lobby/backup/upload-url", { token: lobby, body: { sessionId, baseRev, size: data.length, sha256 } });
  expect(t.status).toBe(200);
  const ctx = createExecutionContext();
  await app.request(t.body.url, { method: "PUT", headers: t.body.headers, body: data }, env, ctx);
  await waitOnExecutionContext(ctx);
  return {
    target: t.body,
    commit: () =>
      call("POST", "/lobby/backup/commit", { token: lobby, body: { sessionId, baseRev, rev: t.body.rev, key: t.body.key, size: data.length, sha256 } }),
  };
}

describe("lobby backups", () => {
  it("backs up, then hands out the latest", async () => {
    const s = (await claimAs()).body.sessionId;
    expect((await call("GET", "/lobby/backup/latest", { token: lobby })).body).toEqual({ latest: null });
    const b = await backup(s, "first");
    expect(b.target.key).toMatch(/^lobby\/1-[0-9a-f-]+\.zip$/);
    expect((await b.commit()).body).toEqual({ rev: 1 });
    const latest = (await call("GET", "/lobby/backup/latest", { token: lobby })).body.latest;
    expect(latest).toMatchObject({ rev: 1, size: 5, sha256: await sha256Hex("first") });
    expect(latest.url).toBe(`http://localhost/dev/r2/${b.target.key}`);
  });

  it("a retried commit is fine; a session that lost the slot can't back up", async () => {
    const s = (await claimAs()).body.sessionId;
    const b = await backup(s, "first");
    await b.commit();
    expect((await b.commit()).body).toEqual({ rev: 1 });
    await env.DB.prepare("UPDATE lobby_slot SET expires_at = ? WHERE id = 1").bind(Date.now() - 1).run();
    await claimAs({ machine: "pi" });
    const r = await call("POST", "/lobby/backup/upload-url", { token: lobby, body: { sessionId: s, baseRev: 1, size: 3, sha256: await sha256Hex("old") } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("lease_lost");
  });

  it("a lobby whose folder is older than the latest backup can't back up over it", async () => {
    // Fedora backs up rev 1, then its slot lapses; the Pi runs, backs up rev 2 and leaves.
    const fedora = (await claimAs()).body.sessionId;
    await (await backup(fedora, "fedora 1")).commit();
    await env.DB.prepare("UPDATE lobby_slot SET expires_at = ? WHERE id = 1").bind(Date.now() - 1).run();
    const pi = (await claimAs({ machine: "pi" })).body.sessionId;
    await (await backup(pi, "pi 2", 1)).commit();
    await call("POST", "/lobby/release", { token: lobby, body: { sessionId: pi } });
    // Fedora reclaims the free slot, but its folder is still based on rev 1.
    const again = (await claimAs({ previousSessionId: fedora })).body.sessionId;
    const sha256 = await sha256Hex("fedora stale");
    const u = await call("POST", "/lobby/backup/upload-url", { token: lobby, body: { sessionId: again, baseRev: 1, size: 12, sha256 } });
    expect(u.status).toBe(409);
    expect(u.body.error).toBe("stale_rev");
    // Even with an upload already in storage as rev 3, the commit is refused.
    const key = "lobby/3-stale.zip";
    await env.BUCKET.put(key, "fedora stale");
    const c = await call("POST", "/lobby/backup/commit", { token: lobby, body: { sessionId: again, baseRev: 1, rev: 3, key, size: 12, sha256 } });
    expect(c.status).toBe(409);
    expect(c.body.error).toBe("stale_rev");
    expect(await env.DB.prepare("SELECT MAX(rev) AS rev FROM lobby_backups").first("rev")).toBe(2);
    // Based on the latest backup, it can.
    expect((await (await backup(again, "fedora 3", 2)).commit()).body).toEqual({ rev: 3 });
  });

  it("refuses a commit whose upload never arrived", async () => {
    const s = (await claimAs()).body.sessionId;
    const t = await call("POST", "/lobby/backup/upload-url", { token: lobby, body: { sessionId: s, baseRev: 0, size: 3, sha256: await sha256Hex("abc") } });
    const r = await call("POST", "/lobby/backup/commit", {
      token: lobby,
      body: { sessionId: s, baseRev: 0, rev: t.body.rev, key: t.body.key, size: 3, sha256: await sha256Hex("abc") },
    });
    expect(r.body.error).toBe("upload_missing");
  });

  it("keeps the last 3 backups", async () => {
    const s = (await claimAs()).body.sessionId;
    for (let i = 1; i <= 4; i++) await (await backup(s, `backup ${i}`, i - 1)).commit();
    const revs = (await env.DB.prepare("SELECT rev FROM lobby_backups ORDER BY rev").all<{ rev: number }>()).results.map((r) => r.rev);
    expect(revs).toEqual([2, 3, 4]);
    expect((await env.BUCKET.list({ prefix: "lobby/" })).objects).toHaveLength(3);
  });
});
