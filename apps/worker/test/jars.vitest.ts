import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { addUser, call, fabricJar, putJar } from "./helpers";

async function download(sha512: string, auth?: string) {
  const ctx = createExecutionContext();
  const res = await app.request(`/jars/${sha512}`, { headers: auth ? { Authorization: auth } : {} }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("PUT /admin/jars/:sha512", () => {
  it("stores the jar and its row, then reports it as already there", async () => {
    const bytes = fabricJar();
    const first = await putJar(bytes);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      created: true,
      jar: { sha512: first.sha512, filename: "deeper end.jar", modId: "dragonbond", version: "1.1.1", minecraftRange: "=26.3", depends: ["citadel"] },
    });
    expect(await env.BUCKET.head(`jars/${first.sha512}.jar`)).not.toBeNull();
    const again = await putJar(bytes);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });

  it("rejects a jar for another Minecraft version and stores nothing", async () => {
    const r = await putJar(fabricJar({ depends: { minecraft: "=26.1.2" } }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("deeper end.jar is built for Minecraft =26.1.2, but the profile is on 26.3.");
    expect(await env.BUCKET.head(`jars/${r.sha512}.jar`)).toBeNull();
    expect((await call("GET", `/admin/jars/${r.sha512}`, { admin: true })).status).toBe(404);
  });

  // Review focus 4: an existing row doesn't skip the check against a new target.
  it("checks a known jar again against the requested Minecraft version", async () => {
    const bytes = fabricJar();
    await putJar(bytes);
    const r = await putJar(bytes, { minecraft: "26.4" });
    expect(r.status).toBe(400);
  });

  it("rejects a body that doesn't match the sha512 in the path", async () => {
    const r = await putJar(fabricJar(), { sha512: "0".repeat(128) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("upload_missing");
  });

  it("rejects missing query parameters and a bad secret", async () => {
    expect((await putJar(fabricJar(), { java: "x" })).status).toBe(400);
    expect((await putJar(fabricJar(), {}, "Bearer nope")).status).toBe(401);
  });
});

describe("GET /admin/jars/:sha512", () => {
  it("returns the stored info", async () => {
    const { sha512 } = await putJar(fabricJar());
    const r = await call("GET", `/admin/jars/${sha512}`, { admin: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sha512, modId: "dragonbond", javaRange: ">=25" });
  });
});

describe("GET /jars/:sha512", () => {
  it("serves the bytes to a hosting token or the admin secret", async () => {
    const bytes = fabricJar();
    const { sha512 } = await putJar(bytes);
    const token = await addUser();
    for (const auth of [`Bearer ${token}`, "Bearer test-admin"]) {
      const res = await download(sha512, auth);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    }
  });

  it("refuses anonymous downloads and 404s unknown jars", async () => {
    const { sha512 } = await putJar(fabricJar());
    expect((await download(sha512)).status).toBe(401);
    expect((await download("0".repeat(128), "Bearer test-admin")).status).toBe(404);
  });
});
