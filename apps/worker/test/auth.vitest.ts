import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adminAuth, agentAuth } from "../src/auth";
import type { AppEnv } from "../src/env";
import { handleError } from "../src/errors";
import { addUser, ADMIN_SECRET, call } from "./helpers";

function probe() {
  const t = new Hono<AppEnv>();
  t.onError(handleError);
  t.get("/agent", agentAuth, (c) => c.text(c.var.userName));
  t.get("/admin", adminAuth, (c) => c.text("admin ok"));
  return t;
}
const get = (path: string, auth?: string) =>
  probe().request(path, { headers: auth ? { Authorization: auth } : {} }, env);

describe("health and unknown routes", () => {
  it("answers /health", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body).toBe("ok");
  });
  it("answers unknown paths with a JSON not_found", async () => {
    const r = await call("GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
  });
});

describe("agentAuth", () => {
  it("accepts a known token and exposes the user's name", async () => {
    const token = await addUser("100000000000000001", "Alex");
    const res = await get("/agent", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Alex");
  });

  it("rejects a missing, unknown or revoked token with the spec's message", async () => {
    const token = await addUser("100000000000000002", "Sam");
    await env.DB.prepare("UPDATE users SET revoked_at = 5 WHERE discord_id = ?").bind("100000000000000002").run();
    for (const auth of [undefined, "Bearer nope", `Bearer ${token}`, token]) {
      const res = await get("/agent", auth);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "unauthorized",
        message: "Your token was rejected. Ask a maintainer for a new one.",
      });
    }
  });
});

describe("adminAuth", () => {
  it("accepts ADMIN_SECRET and nothing else", async () => {
    expect((await get("/admin", `Bearer ${ADMIN_SECRET}`)).status).toBe(200);
    expect((await get("/admin", "Bearer wrong")).status).toBe(401);
    const token = await addUser("100000000000000003", "Kim");
    expect((await get("/admin", `Bearer ${token}`)).status).toBe(401);
    expect((await get("/admin")).status).toBe(401);
  });
});
