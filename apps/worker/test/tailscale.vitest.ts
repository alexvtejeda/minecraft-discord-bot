import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteDevice, mintAuthKey, TailscaleError } from "../src/tailscale";
import { fakeTailscale } from "./tailscale";

afterEach(() => vi.restoreAllMocks());

describe("mintAuthKey", () => {
  it("gets an access token with the OAuth client, then asks for a single-use tagged key", async () => {
    const calls = fakeTailscale();
    expect(await mintAuthKey(env, "setup mc-alex")).toBe("tskey-auth-test");
    expect(calls[0]!.url).toBe("https://api.tailscale.com/api/v2/oauth/token");
    expect(calls[0]!.body).toBe("client_id=ts-client&client_secret=ts-secret");
    expect(calls[1]).toEqual({
      url: "https://api.tailscale.com/api/v2/tailnet/-/keys",
      method: "POST",
      auth: "Bearer ts-access",
      body: {
        description: "setup mc-alex",
        expirySeconds: 600,
        capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: ["tag:mc-player"] } } },
      },
    });
  });

  it("throws TailscaleError with Tailscale's answer when it refuses", async () => {
    fakeTailscale({ mint: "fail" });
    await expect(mintAuthKey(env, "x")).rejects.toThrow(TailscaleError);
    await expect(mintAuthKey(env, "x")).rejects.toThrow(/403.*requested tags are invalid/);
  });

  it("throws TailscaleError when Tailscale can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(mintAuthKey(env, "x")).rejects.toThrow(TailscaleError);
  });
});

describe("deleteDevice", () => {
  it("deletes by node id", async () => {
    const calls = fakeTailscale();
    await deleteDevice(env, "nABC123CNTRL");
    expect(calls[1]).toMatchObject({ url: "https://api.tailscale.com/api/v2/device/nABC123CNTRL", method: "DELETE", auth: "Bearer ts-access" });
  });

  it("counts a device that's already gone as deleted", async () => {
    fakeTailscale({ deleteStatus: { gone: 404 } });
    await expect(deleteDevice(env, "gone")).resolves.toBeUndefined();
  });

  it("throws TailscaleError on other failures", async () => {
    fakeTailscale({ deleteStatus: { broken: 500 } });
    await expect(deleteDevice(env, "broken")).rejects.toThrow(TailscaleError);
  });
});
