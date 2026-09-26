import { expect, test } from "bun:test";
import type { Fetch } from "@mc/profile";
import {
  createAdminApi,
  createAgentApi,
  hhmm,
  LeaseHeldError,
  LeaseLostError,
  OfflineError,
  StaleRevError,
} from "../src/host/api";

type Seen = { url: string; method: string; auth: string | null; body: unknown };
function fakeFetch(reply: (url: string) => Response | Promise<Response>): { fetch: Fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? "GET", auth: headers.get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return reply(url);
  };
  return { fetch, seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SHA = "a".repeat(64);

test("the agent client sends the bearer token and parses replies", async () => {
  const { fetch, seen } = fakeFetch(() => json({ sessionId: "s".repeat(16), baseRev: 3, expiresAt: 9 }));
  const api = createAgentApi({ workerUrl: "https://w.test/", token: "tok", fetch });
  expect(await api.claim("100.64.0.3")).toEqual({ sessionId: "s".repeat(16), baseRev: 3, expiresAt: 9 });
  expect(seen[0]).toEqual({ url: "https://w.test/agent/lease/claim", method: "POST", auth: "Bearer tok", body: { hostAddress: "100.64.0.3" } });
});

test("commit returns the new rev", async () => {
  const { fetch } = fakeFetch(() => json({ rev: 4 }));
  const api = createAgentApi({ workerUrl: "https://w.test", token: "t", fetch });
  expect(await api.commit({ sessionId: "s".repeat(16), rev: 4, key: "k", size: 1, sha256: SHA })).toBe(4);
});

test("lease_held becomes LeaseHeldError with the spec's sentence", async () => {
  const claimedAt = new Date(2026, 8, 26, 20, 14).getTime();
  const { fetch } = fakeFetch(() =>
    json({ error: "lease_held", message: "x", holder: { name: "Alex", hostAddress: "100.64.0.3", claimedAt, expiresAt: 0 } }, 409),
  );
  const api = createAgentApi({ workerUrl: "https://w.test", token: "t", fetch });
  const err = await api.claim("h").catch((e) => e);
  expect(err).toBeInstanceOf(LeaseHeldError);
  expect(err.message).toBe("Alex is already hosting at 100.64.0.3 (since 20:14).");
});

test("lease_lost and stale_rev get their own classes; other codes are plain UserErrors", async () => {
  const reply = (error: string) => fakeFetch(() => json({ error, message: `msg ${error}` }, 409)).fetch;
  const api = (error: string) => createAgentApi({ workerUrl: "https://w.test", token: "t", fetch: reply(error) });
  expect(await api("lease_lost").heartbeat("s".repeat(16)).catch((e) => e)).toBeInstanceOf(LeaseLostError);
  expect(await api("stale_rev").uploadUrl({ sessionId: "s".repeat(16), baseRev: 0, size: 1, sha256: SHA }).catch((e) => e)).toBeInstanceOf(StaleRevError);
  const other = await api("no_active_world").manifest().catch((e) => e);
  expect(other.message).toBe("msg no_active_world");
});

test("network failures and non-JSON errors become OfflineError", async () => {
  const down: Fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const e1 = await createAgentApi({ workerUrl: "https://w.test", token: "t", fetch: down }).manifest().catch((e) => e);
  expect(e1).toBeInstanceOf(OfflineError);
  expect(e1.message).toStartWith("Can't reach the server list at https://w.test.");
  const { fetch } = fakeFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
  expect(await createAgentApi({ workerUrl: "https://w.test", token: "t", fetch }).manifest().catch((e) => e)).toBeInstanceOf(OfflineError);
});

test("the admin client uses the admin secret and unwraps replies", async () => {
  const { fetch, seen } = fakeFetch((url) =>
    url.endsWith("/admin/tokens") ? json({ token: "t".repeat(43) }, 201) : json({ released: null }),
  );
  const api = createAdminApi({ workerUrl: "https://w.test", secret: "sec", fetch });
  expect(await api.mintToken({ discordId: "123456789012345678", name: "Sam" })).toBe("t".repeat(43));
  expect(await api.releaseLease()).toBeNull();
  expect(seen.map((s) => s.auth)).toEqual(["Bearer sec", "Bearer sec"]);
});

test("hhmm pads local hours and minutes", () => {
  expect(hhmm(new Date(2026, 0, 1, 7, 5).getTime())).toBe("07:05");
});
