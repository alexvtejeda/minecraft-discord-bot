import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { base64ToHex, devStorage, hexToBase64, r2Storage, storageFor } from "../src/storage";
import { envWith } from "./helpers";

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sha = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("hex and base64", () => {
  it("round-trips the sha256 of the empty string", () => {
    expect(hexToBase64(EMPTY_SHA)).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    expect(base64ToHex("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=")).toBe(EMPTY_SHA);
  });
});

describe("r2Storage", () => {
  const fixed = () => new Date("2026-09-26T12:00:00Z");
  const s = r2Storage(envWith({ R2_ACCOUNT_ID: "acct", R2_BUCKET_NAME: "mc-bot" }), fixed);

  it("presigns a GET on the account endpoint that expires in an hour", async () => {
    const url = new URL(await s.getUrl("worlds/w1/1-abc.zip"));
    expect(url.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/mc-bot/worlds/w1/1-abc.zip");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260926T120000Z");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs the checksum header into a PUT and returns it for the uploader", async () => {
    const t = await s.putTarget("worlds/w1/2-abc.zip", EMPTY_SHA);
    expect(t.headers).toEqual({ "x-amz-checksum-sha256": hexToBase64(EMPTY_SHA) });
    expect(new URL(t.url).searchParams.get("X-Amz-SignedHeaders")).toContain("x-amz-checksum-sha256");
  });

  it("is deterministic for a fixed clock", async () => {
    expect(await s.getUrl("k.zip")).toBe(await s.getUrl("k.zip"));
  });
});

describe("dev proxy", () => {
  it("picks dev URLs only when DEV_R2_PROXY is 1", async () => {
    expect(await storageFor(envWith({ DEV_R2_PROXY: "1" }), "http://localhost/agent/x").getUrl("a/b.zip")).toBe(
      "http://localhost/dev/r2/a/b.zip",
    );
    expect(await storageFor(envWith({ DEV_R2_PROXY: undefined }), "http://localhost/x").getUrl("a/b.zip")).toContain(
      "r2.cloudflarestorage.com",
    );
  });

  it("stores a PUT whose checksum matches and serves it back", async () => {
    const body = new TextEncoder().encode("world bytes");
    const t = await devStorage("http://localhost").putTarget("worlds/w1/1-a.zip", await sha(body));
    const put = await app.request(t.url, { method: "PUT", headers: t.headers, body }, env);
    expect(put.status).toBe(200);
    const head = await env.BUCKET.head("worlds/w1/1-a.zip");
    expect(head?.size).toBe(body.length);
    const get = await app.request("http://localhost/dev/r2/worlds/w1/1-a.zip", {}, env);
    expect(await get.text()).toBe("world bytes");
  });

  it("rejects a PUT whose body doesn't match the checksum, like R2 does", async () => {
    const t = await devStorage("http://localhost").putTarget("worlds/w1/1-b.zip", EMPTY_SHA);
    const put = await app.request(t.url, { method: "PUT", headers: t.headers, body: "not empty" }, env);
    expect(put.status).toBe(400);
    expect(await env.BUCKET.head("worlds/w1/1-b.zip")).toBeNull();
  });

  it("is switched off without DEV_R2_PROXY", async () => {
    const res = await app.request("http://localhost/dev/r2/x.zip", {}, envWith({ DEV_R2_PROXY: undefined }));
    expect(res.status).toBe(404);
  });
});
