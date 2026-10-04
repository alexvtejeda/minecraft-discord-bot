import { sha256Hex } from "@mc/profile";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { addLobby, addUser, call } from "./helpers";

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
