import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha512Hex, type Fetch } from "@mc/profile";
import { fetchVerified } from "../src/download";

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
