import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALEX, ANNOUNCE_CHANNEL, announceEnv, captureDiscord } from "./discord";
import { addUser, addWorld, call, envWith } from "./helpers";

let token: string;
beforeEach(async () => {
  token = await addUser(ALEX, "Alex");
  await addWorld("w1");
});
afterEach(() => vi.restoreAllMocks());

const claim = (e = announceEnv()) => call("POST", "/agent/lease/claim", { token, body: { hostAddress: "100.64.0.3" }, env: e });

describe("announcements", () => {
  it("posts when someone starts hosting", async () => {
    const posts = captureDiscord();
    expect((await claim()).status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: `https://discord.com/api/v10/channels/${ANNOUNCE_CHANNEL}/messages`,
      method: "POST",
      auth: "Bot test-bot-token",
      body: {
        content: `🟢 <@${ALEX}> is hosting **w1** (26.3) at \`100.64.0.3:25565\`. \`/join\` for how to connect.`,
        allowed_mentions: { users: [ALEX] },
      },
    });
  });

  it("posts the saved rev when they stop", async () => {
    const posts = captureDiscord();
    const { sessionId } = (await claim()).body;
    await env.DB.prepare(
      "INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at) VALUES ('w1', 3, 'k', 1, 'x', ?, 1)",
    )
      .bind(ALEX)
      .run();
    expect((await call("POST", "/agent/lease/release", { token, body: { sessionId }, env: announceEnv() })).status).toBe(200);
    expect(posts[1]!.body.content).toBe(`🔴 <@${ALEX}> stopped the server. World saved as rev 3.`);
  });

  it("says so when nothing was saved", async () => {
    const posts = captureDiscord();
    const { sessionId } = (await claim()).body;
    await call("POST", "/agent/lease/release", { token, body: { sessionId }, env: announceEnv() });
    expect(posts[1]!.body.content).toBe(`🔴 <@${ALEX}> stopped the server. Nothing was saved yet.`);
  });

  it("never fails the agent's request when Discord does", async () => {
    captureDiscord({ fail: true });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await claim()).status).toBe(200);
    expect(log).toHaveBeenCalledWith("announcement failed", expect.any(Error));
  });

  it("posts nothing without a channel, or on heartbeat", async () => {
    const posts = captureDiscord();
    const { sessionId } = (await claim(envWith({}))).body;
    await call("POST", "/agent/lease/heartbeat", { token, body: { sessionId }, env: announceEnv() });
    expect(posts).toHaveLength(0);
  });
});
