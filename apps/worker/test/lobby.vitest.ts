import { sha256Hex } from "@mc/profile";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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
