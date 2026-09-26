import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimLease,
  forceRelease,
  heartbeatLease,
  isHeld,
  LEASE_MS,
  readLease,
  releaseLease,
  requireSession,
} from "../src/lease";
import { addUser, addWorld } from "./helpers";

const ALEX = "100000000000000001";
const SAM = "100000000000000002";
const claim = (userId: string, now: number, hostAddress = "100.64.0.3") =>
  claimLease(env.DB, { userId, hostAddress, worldId: "w1", now });

beforeEach(async () => {
  await addUser(ALEX, "Alex");
  await addUser(SAM, "Sam");
  await addWorld("w1");
});

describe("claim", () => {
  it("takes a free lease and starts at the latest rev", async () => {
    await env.DB.prepare(
      "INSERT INTO snapshots (world_id, rev, r2_key, size, sha256, uploaded_by, created_at) VALUES ('w1', 1, 'k1', 1, 'x', 'a', 1), ('w1', 2, 'k2', 1, 'x', 'a', 2)",
    ).run();
    const c = await claim(ALEX, 1_000);
    expect(c.baseRev).toBe(2);
    expect(c.expiresAt).toBe(1_000 + LEASE_MS);
    expect(c.sessionId.length).toBeGreaterThanOrEqual(16);
    const l = await readLease(env.DB);
    expect(l.holder_name).toBe("Alex");
    expect(isHeld(l, 1_000)).toBe(true);
  });

  it("refuses someone else while held, naming the holder", async () => {
    await claim(ALEX, 1_000);
    await expect(claim(SAM, 2_000, "100.64.0.9")).rejects.toMatchObject({
      code: "lease_held",
      holder: { name: "Alex", hostAddress: "100.64.0.3", claimedAt: 1_000 },
    });
  });

  it("lets someone else take an expired lease, which kills the old session", async () => {
    const old = await claim(ALEX, 1_000);
    const next = await claim(SAM, 1_000 + LEASE_MS + 1);
    expect(next.sessionId).not.toBe(old.sessionId);
    await expect(heartbeatLease(env.DB, old.sessionId, 5_000)).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("lets the holder re-claim, rotating the session (second PC case)", async () => {
    const first = await claim(ALEX, 1_000);
    const second = await claim(ALEX, 2_000, "100.64.0.7");
    expect(second.sessionId).not.toBe(first.sessionId);
    await expect(heartbeatLease(env.DB, first.sessionId, 3_000)).rejects.toMatchObject({ code: "lease_lost" });
    expect((await readLease(env.DB)).host_address).toBe("100.64.0.7");
  });

  it("gives exactly one winner when two people claim at once", async () => {
    const results = await Promise.allSettled([claim(ALEX, 1_000), claim(SAM, 1_000)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("heartbeat, release and force release", () => {
  it("heartbeat pushes the expiry out", async () => {
    const c = await claim(ALEX, 1_000);
    expect(await heartbeatLease(env.DB, c.sessionId, 50_000)).toBe(50_000 + LEASE_MS);
    expect((await readLease(env.DB)).expires_at).toBe(50_000 + LEASE_MS);
  });

  it("release clears the lease; a stale session can't release", async () => {
    const c = await claim(ALEX, 1_000);
    await expect(releaseLease(env.DB, "not-the-session-id")).rejects.toMatchObject({ code: "lease_lost" });
    await releaseLease(env.DB, c.sessionId);
    const l = await readLease(env.DB);
    expect(l.holder_id).toBeNull();
    expect(isHeld(l, 1_000)).toBe(false);
    await expect(requireSession(env.DB, c.sessionId)).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("force release reports who held it, then nothing", async () => {
    await claim(ALEX, 1_000);
    expect(await forceRelease(env.DB, 2_000)).toMatchObject({ name: "Alex" });
    expect(await forceRelease(env.DB, 2_000)).toBeNull();
  });

  it("an expired lease isn't held", async () => {
    await claim(ALEX, 1_000);
    expect(isHeld(await readLease(env.DB), 1_000 + LEASE_MS + 1)).toBe(false);
  });

  it("requireSession returns the lease for the current session", async () => {
    const c = await claim(ALEX, 1_000);
    expect((await requireSession(env.DB, c.sessionId)).world_id).toBe("w1");
  });
});
