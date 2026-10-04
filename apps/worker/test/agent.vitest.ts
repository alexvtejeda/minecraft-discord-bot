import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { addUser, call, lobbyUp, worldFiles } from "./helpers";

let alex: string;
let sam: string;
beforeEach(async () => {
  alex = await addUser("100000000000000001", "Alex");
  sam = await addUser("100000000000000002", "Sam");
});
async function makeWorld(name = "w") {
  const { profile, lockfile } = await worldFiles();
  return (await call("POST", "/admin/worlds", { admin: true, body: { name, profile, lockfile } })).body as { id: string };
}
const claim = (token: string, hostAddress = "100.64.0.3") => call("POST", "/agent/lease/claim", { token, body: { hostAddress } });

describe("GET /agent/manifest", () => {
  it("names the lobby while it's up", async () => {
    await makeWorld();
    await lobbyUp("100.64.0.50");
    expect((await call("GET", "/agent/manifest", { token: alex })).body.lobby).toEqual({ address: "100.64.0.50" });
  });

  it("says no world is active, in the spec's words", async () => {
    const r = await call("GET", "/agent/manifest", { token: alex });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      error: "no_active_world",
      message: "No world is active yet. A maintainer runs `mc-host admin world create <profile>`.",
    });
  });

  it("describes a fresh world with its pinned files", async () => {
    const { id } = await makeWorld("fresh");
    const { profile, lockfile } = await worldFiles();
    const r = await call("GET", "/agent/manifest", { token: alex });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      world: { id, name: "fresh", minecraft: "26.3" },
      profile: JSON.parse(JSON.stringify(profile)),
      lockfile: JSON.parse(JSON.stringify(lockfile)),
      pregenDone: false,
      latest: null,
      lease: null,
      lobby: null,
    });
  });

  it("links the latest snapshot and shows the lease from each side", async () => {
    const { id } = await makeWorld();
    await env.BUCKET.put(`worlds/${id}/1-a.zip`, "zip");
    await env.DB.prepare("INSERT INTO snapshots VALUES (?, 1, ?, 3, ?, 'x', 1)").bind(id, `worlds/${id}/1-a.zip`, "b".repeat(64)).run();
    await claim(alex);
    const mine = await call("GET", "/agent/manifest", { token: alex });
    expect(mine.body.latest).toMatchObject({ rev: 1, size: 3, sha256: "b".repeat(64) });
    expect(mine.body.latest.url).toBe(`http://localhost/dev/r2/worlds/${id}/1-a.zip`);
    expect(mine.body.lease).toMatchObject({ name: "Alex", hostAddress: "100.64.0.3", you: true });
    expect((await call("GET", "/agent/manifest", { token: sam })).body.lease.you).toBe(false);
  });
});

describe("lease routes", () => {
  it("claim, heartbeat and release over HTTP", async () => {
    await makeWorld();
    const c = await claim(alex);
    expect(c.status).toBe(200);
    expect(c.body.baseRev).toBe(0);
    const hb = await call("POST", "/agent/lease/heartbeat", { token: alex, body: { sessionId: c.body.sessionId } });
    expect(hb.status).toBe(200);
    expect(hb.body.expiresAt).toBeGreaterThan(Date.now());
    const rel = await call("POST", "/agent/lease/release", { token: alex, body: { sessionId: c.body.sessionId } });
    expect(rel.body).toEqual({ ok: true });
  });

  it("a second claimer gets lease_held with the holder", async () => {
    await makeWorld();
    await claim(alex);
    const r = await claim(sam, "100.64.0.9");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("lease_held");
    expect(r.body.holder).toMatchObject({ name: "Alex", hostAddress: "100.64.0.3" });
  });

  it("a stale session's heartbeat gets lease_lost", async () => {
    await makeWorld();
    const first = await claim(alex);
    await claim(alex, "100.64.0.7");
    const hb = await call("POST", "/agent/lease/heartbeat", { token: alex, body: { sessionId: first.body.sessionId } });
    expect(hb.status).toBe(409);
    expect(hb.body.error).toBe("lease_lost");
  });

  it("claim needs an active world and a valid body", async () => {
    expect((await claim(alex)).body.error).toBe("no_active_world");
    await makeWorld();
    const bad = await call("POST", "/agent/lease/claim", { token: alex, body: { hostAddress: "" } });
    expect(bad.status).toBe(400);
  });
});
