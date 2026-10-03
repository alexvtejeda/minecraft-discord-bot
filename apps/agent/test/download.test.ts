import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha512Hex, UserError, type Fetch, type LockEntry } from "@mc/profile";
import { fetchVerified, sourceFor } from "../src/download";

const good = new TextEncoder().encode("jar bytes");
const bad = new TextEncoder().encode("corrupt!!");
let dir: string;
let goodHash: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-dl-"));
  goodHash = await sha512Hex(good);
});

function serve(bodies: Uint8Array[]) {
  let calls = 0;
  const fetch: Fetch = async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)]!;
    calls++;
    return new Response(body);
  };
  return { fetch, calls: () => calls };
}

const URL_ = "https://cdn.modrinth.com/data/x/Waystones%201.0.jar";

test("downloads, verifies and caches by hash", async () => {
  const s = serve([good]);
  const path = await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(readFileSync(path)).toEqual(Buffer.from(good));
  await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(s.calls()).toBe(1);
});

test("retries once after a hash mismatch", async () => {
  const s = serve([bad, good]);
  const path = await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(readFileSync(path)).toEqual(Buffer.from(good));
  expect(s.calls()).toBe(2);
});

test("fails after two mismatches and leaves nothing in the cache", async () => {
  const s = serve([bad, bad]);
  await expect(fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" })).rejects.toThrow(
    /Waystones 1\.0\.jar was corrupted twice/,
  );
  const files = existsSync(join(dir, "files")) ? readdirSync(join(dir, "files"), { recursive: true }) : [];
  expect(files.filter((f) => String(f).length > 3)).toEqual([]);
});

test("re-downloads a cached file that was tampered with", async () => {
  const s = serve([good]);
  const path = await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  await Bun.write(path, bad);
  await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(s.calls()).toBe(2);
  expect(readFileSync(path)).toEqual(Buffer.from(good));
});

test("without a hash, caches by URL", async () => {
  const s = serve([good]);
  const a = await fetchVerified("https://meta.test/server/jar", undefined, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  const b = await fetchVerified("https://meta.test/server/jar", undefined, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(a).toBe(b);
  expect(s.calls()).toBe(1);
});

test("an HTTP error is a plain-English UserError", async () => {
  const fetch: Fetch = async () => new Response("", { status: 503 });
  await expect(fetchVerified(URL_, goodHash, { fetch, cacheDir: dir, userAgent: "ua" })).rejects.toThrow(
    /Couldn't download Waystones 1\.0\.jar \(HTTP 503\)/,
  );
});

// Final review I4
test("retries a network error once, then gives a plain-English error", async () => {
  let calls = 0;
  const flaky: Fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNRESET");
    return new Response(good);
  };
  await fetchVerified(URL_, goodHash, { fetch: flaky, cacheDir: dir, userAgent: "ua" });
  expect(calls).toBe(2);
  const down: Fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const p = fetchVerified("https://cdn.modrinth.com/data/y/Other.jar", await sha512Hex(bad), { fetch: down, cacheDir: dir, userAgent: "ua" });
  await expect(p).rejects.toBeInstanceOf(UserError);
  await expect(p).rejects.toThrow(/Couldn't download Other\.jar \(getaddrinfo ENOTFOUND\)\. Check your internet connection/);
});

test("sourceFor leaves Modrinth entries alone and points jars at the Worker with auth", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    return new Response("ok");
  };
  const mr = { url: "https://cdn.modrinth.com/x.jar", source: undefined } as LockEntry;
  expect(sourceFor(mr, fetch, undefined).url).toBe("https://cdn.modrinth.com/x.jar");
  const jar = { url: `jars/${"a".repeat(128)}`, source: "jar", filename: "a b.jar" } as LockEntry;
  const s = sourceFor(jar, fetch, { workerUrl: "https://w.test", secret: "tok" });
  expect(s.url).toBe(`https://w.test/jars/${"a".repeat(128)}`);
  await s.fetch(s.url, { headers: { "User-Agent": "ua" } });
  expect(calls).toEqual([{ url: s.url, auth: "Bearer tok" }]);
  expect(() => sourceFor(jar, fetch, undefined)).toThrow(/a b\.jar is an uploaded jar/);
});
