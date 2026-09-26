import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { verifyDiscordRequest } from "../src/discord/verify";
import { postInteraction, slash } from "./discord";

describe("POST /interactions", () => {
  it("answers PING with PONG", async () => {
    expect(await postInteraction({ type: 1 })).toEqual({ status: 200, body: { type: 1 } });
  });

  it("rejects a body changed after signing", async () => {
    const r = await postInteraction({ type: 1 }, { tamper: (b) => b.replace("1", "2") });
    expect(r).toEqual({ status: 401, body: "Bad request signature." });
  });

  it("rejects a timestamp that wasn't the one signed", async () => {
    const r = await postInteraction({ type: 1 }, { timestamp: "1700000001", signTimestamp: "1700000000" });
    expect(r.status).toBe(401);
  });

  it("rejects a missing or malformed signature", async () => {
    expect((await postInteraction({ type: 1 }, { signature: "" })).status).toBe(401);
    expect((await postInteraction({ type: 1 }, { signature: "zz" })).status).toBe(401);
    expect((await postInteraction({ type: 1 }, { signature: "ab".repeat(64) })).status).toBe(401);
  });
});

describe("verifyDiscordRequest", () => {
  it("is false for a public key that isn't 32 bytes of hex", async () => {
    expect(await verifyDiscordRequest("abcd", "ab".repeat(64), "1", "{}")).toBe(false);
    expect(await verifyDiscordRequest("", "ab".repeat(64), "1", "{}")).toBe(false);
  });

  it("is false without a timestamp", async () => {
    expect(await verifyDiscordRequest(env.DISCORD_PUBLIC_KEY, "ab".repeat(64), undefined, "{}")).toBe(false);
  });
});

describe("POST /interactions dispatch", () => {
  it("routes a slash command through the real registry", async () => {
    const r = await postInteraction(slash("help"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(r.body.data.content).toContain("`/help`");
  });
});
