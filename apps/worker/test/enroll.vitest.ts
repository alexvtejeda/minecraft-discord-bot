import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tailnetHostname } from "../src/enroll";
import { ALEX, postInteraction, SAM, slash } from "./discord";
import { call } from "./helpers";
import { fakeTailscale } from "./tailscale";

afterEach(() => vi.restoreAllMocks());

const EXPIRED = { error: "expired", message: "This setup link expired. Run /setup in Discord again." };

async function setupCode(mode: "play" | "host" = "play", username = "Alex.V_T"): Promise<string> {
  const r = await postInteraction(slash(`setup ${mode}`, {}, { username }));
  return /\/s\/([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(r.body.data.content)![1]!;
}
const user = () => env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(ALEX).first<any>();
const devices = () => env.DB.prepare("SELECT node_id, discord_id, hostname FROM devices").all().then((r) => r.results);

describe("tailnetHostname", () => {
  it("keeps letters, digits and dashes", () => {
    expect(tailnetHostname("Alex.V_T", "100000000000000001")).toBe("mc-alex-v-t");
  });
  it("falls back to the id when nothing is left", () => {
    expect(tailnetHostname("🎮", "100000000000000042")).toBe("mc-player-0042");
  });
  it("stays within 40 characters and never ends in a dash", () => {
    const h = tailnetHostname(`${"a".repeat(36)}_b${"c".repeat(30)}`, "1");
    expect(h.length).toBeLessThanOrEqual(40);
    expect(h).not.toMatch(/-$/);
  });
});

describe("GET /s/:code", () => {
  it("serves the installer with this Worker's URL, the code and the mode filled in", async () => {
    const code = await setupCode("host");
    const r = await call("GET", `/s/${code}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("$WorkerUrl = 'http://localhost'");
    expect(r.body).toContain(`$Code = '${code}'`);
    expect(r.body).toContain("$Mode = 'host'");
    expect(r.body).not.toContain("__");
  });

  it("serving it doesn't use the code up", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("GET", `/s/${code}`);
    expect((await call("POST", "/enroll", { body: { code, join: true } })).status).toBe(200);
  });

  it("serves a script that just prints the expired message for a bad code", async () => {
    const r = await call("GET", "/s/AAAA-AAAA");
    expect(r.status).toBe(200);
    expect(r.body).toBe("Write-Host 'This setup link expired. Run /setup in Discord again.' -ForegroundColor Yellow\n");
  });
});

describe("POST /enroll", () => {
  it("play: mints a network key but no hosting token, and records the player", async () => {
    const calls = fakeTailscale();
    const code = await setupCode();
    const r = await call("POST", "/enroll", { body: { code, join: true } });
    expect(r).toEqual({ status: 200, body: { hostname: "mc-alex-v-t", authKey: "tskey-auth-test" } });
    expect(calls[1]!.body.description).toBe("setup mc-alex-v-t");
    expect(await user()).toMatchObject({ name: "Alex.V_T", revoked_at: null });
  });

  it("host: also returns a hosting token that works", async () => {
    fakeTailscale();
    const code = await setupCode("host");
    const r = await call("POST", "/enroll", { body: { code, join: true } });
    expect(r.body.token).toEqual(expect.any(String));
    const manifest = await call("GET", "/agent/manifest", { token: r.body.token });
    expect(manifest.body.error).toBe("no_active_world"); // past the token check
  });

  it("join:false mints no key (the PC is already on the network)", async () => {
    const calls = fakeTailscale();
    const code = await setupCode("host");
    const r = await call("POST", "/enroll", { body: { code, join: false } });
    expect(r.body.authKey).toBeUndefined();
    expect(r.body.token).toEqual(expect.any(String));
    expect(calls).toEqual([]);
  });

  it("works once", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    expect(await call("POST", "/enroll", { body: { code, join: true } })).toEqual({ status: 410, body: EXPIRED });
  });

  it("only one of two simultaneous redemptions wins", async () => {
    fakeTailscale();
    const code = await setupCode();
    const results = await Promise.all([1, 2].map(() => call("POST", "/enroll", { body: { code, join: true } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  it("accepts the code however it was typed", async () => {
    fakeTailscale();
    const code = await setupCode();
    expect((await call("POST", "/enroll", { body: { code: ` ${code.toLowerCase().replace("-", "")} `, join: true } })).status).toBe(200);
  });

  it("refuses an expired code", async () => {
    fakeTailscale();
    const code = await setupCode();
    await env.DB.prepare("UPDATE enrollments SET expires_at = ?").bind(Date.now() - 1).run();
    expect(await call("POST", "/enroll", { body: { code, join: true } })).toEqual({ status: 410, body: EXPIRED });
  });

  it("leaves the code usable when Tailscale refuses to make a key", async () => {
    fakeTailscale({ mint: "fail" });
    const code = await setupCode();
    const r = await call("POST", "/enroll", { body: { code, join: true } });
    expect(r).toEqual({
      status: 502,
      body: { error: "upstream", message: "Couldn't create your network key. Try again in a minute. If it keeps failing, tell a maintainer." },
    });
    vi.restoreAllMocks();
    fakeTailscale();
    expect((await call("POST", "/enroll", { body: { code, join: true } })).status).toBe(200);
  });
});

describe("POST /enroll/device", () => {
  it("records the device after the code was used", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "nABC123CNTRL" } })).body).toEqual({ ok: true });
    expect(await devices()).toEqual([{ node_id: "nABC123CNTRL", discord_id: ALEX, hostname: "mc-alex-v-t" }]);
  });

  it("refuses a code that hasn't been redeemed", async () => {
    const code = await setupCode();
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "n1" } })).status).toBe(410);
  });

  it("refuses once the 15-minute window has passed", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    await env.DB.prepare("UPDATE enrollments SET used_at = ?").bind(Date.now() - 16 * 60_000).run();
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "n1" } })).status).toBe(410);
    expect(await devices()).toEqual([]);
  });

  it("takes one device report per code", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    await call("POST", "/enroll/device", { body: { code, nodeId: "nMine" } });
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "nOther" } })).status).toBe(410);
    expect(await devices()).toEqual([{ node_id: "nMine", discord_id: ALEX, hostname: "mc-alex-v-t" }]);
  });

  it("won't move someone else's device onto this person", async () => {
    fakeTailscale();
    await env.DB.prepare("INSERT INTO devices (node_id, discord_id, hostname, created_at) VALUES ('nSams', ?, 'mc-sam', 1)").bind(SAM).run();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    const r = await call("POST", "/enroll/device", { body: { code, nodeId: "nSams" } });
    expect(r.status).toBe(409);
    expect(await devices()).toEqual([{ node_id: "nSams", discord_id: SAM, hostname: "mc-sam" }]);
  });

  it("refuses a device that isn't a tagged Minecraft device", async () => {
    fakeTailscale({ deviceTags: { nMaintainer: [], nGone: null } });
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "nMaintainer" } })).status).toBe(409);
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "nGone" } })).status).toBe(409);
    expect(await devices()).toEqual([]);
  });

  it("rejects a node id that isn't one", async () => {
    fakeTailscale();
    const code = await setupCode();
    await call("POST", "/enroll", { body: { code, join: true } });
    expect((await call("POST", "/enroll/device", { body: { code, nodeId: "n1; DROP" } })).status).toBe(400);
  });
});
