import { expect, test } from "bun:test";
import { UserError } from "../src/errors";
import { sha256Hex, sha512Hex } from "../src/hash";
import { getJson, type Fetch } from "../src/http";

function sequence(items: (Response | Error)[]) {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const fetch: Fetch = async (url, init) => {
    urls.push(url);
    headers.push(new Headers(init?.headers));
    const next = items.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, urls, headers };
}

test("returns parsed JSON and sends the User-Agent", async () => {
  const s = sequence([Response.json({ ok: 1 })]);
  const data = await getJson<{ ok: number }>({ fetch: s.fetch, userAgent: "ua/1" }, "https://x.test/a");
  expect(data).toEqual({ ok: 1 });
  expect(s.headers[0]!.get("User-Agent")).toBe("ua/1");
});

test("returns null on 404", async () => {
  const s = sequence([new Response("", { status: 404 })]);
  expect(await getJson({ fetch: s.fetch, userAgent: "ua" }, "https://x.test/a")).toBeNull();
});

test("waits for X-Ratelimit-Reset on 429, then succeeds", async () => {
  const waits: number[] = [];
  const s = sequence([
    new Response("", { status: 429, headers: { "X-Ratelimit-Reset": "3" } }),
    Response.json([1]),
  ]);
  const data = await getJson(
    { fetch: s.fetch, userAgent: "ua", sleep: async (ms) => void waits.push(ms) },
    "https://x.test/a",
  );
  expect(data).toEqual([1]);
  expect(waits).toEqual([3000]);
});

test("retries a network error", async () => {
  const s = sequence([new Error("ECONNRESET"), Response.json("fine")]);
  const data = await getJson({ fetch: s.fetch, userAgent: "ua", sleep: async () => {} }, "https://x.test/a");
  expect(data).toBe("fine");
});

test("gives up after maxAttempts with a plain-English UserError", async () => {
  const s = sequence([503, 503, 503].map((status) => new Response("", { status })));
  const p = getJson({ fetch: s.fetch, userAgent: "ua", sleep: async () => {}, maxAttempts: 3 }, "https://api.x.test/a");
  await expect(p).rejects.toBeInstanceOf(UserError);
  await expect(p).rejects.toThrow(/api\.x\.test isn't responding \(HTTP 503\)\. Try again in a few minutes\./);
});

test("does not retry other 4xx errors", async () => {
  const s = sequence([new Response("", { status: 400 })]);
  await expect(getJson({ fetch: s.fetch, userAgent: "ua" }, "https://x.test/a")).rejects.toThrow(/HTTP 400/);
  expect(s.urls.length).toBe(1);
});

test("hash helpers", async () => {
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect((await sha512Hex(new TextEncoder().encode("abc"))).slice(0, 16)).toBe("ddaf35a193617aba");
});
