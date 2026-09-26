import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@mc/profile";
import { OfflineError } from "../src/host/api";
import { downloadTo, uploadFile } from "../src/host/transfer";

const dir = () => mkdtempSync(join(tmpdir(), "mc-xfer-"));

test("downloadTo streams the body into the file", async () => {
  const dest = join(dir(), "sub", "a.zip");
  await downloadTo(async () => new Response("zip bytes"), "https://r2.test/a.zip", dest);
  expect(readFileSync(dest, "utf8")).toBe("zip bytes");
});

test("downloadTo turns failures into OfflineError", async () => {
  const down: Fetch = async () => {
    throw new Error("reset");
  };
  expect(await downloadTo(down, "https://r2.test/a", join(dir(), "a")).catch((e) => e)).toBeInstanceOf(OfflineError);
  expect(await downloadTo(async () => new Response("", { status: 403 }), "https://r2.test/a", join(dir(), "a")).catch((e) => e)).toBeInstanceOf(
    OfflineError,
  );
});

test("uploadFile PUTs the file with the signed headers", async () => {
  const file = join(dir(), "up.zip");
  writeFileSync(file, "payload");
  let seen: { method?: string; headers: Headers; body: string } | null = null;
  const fetch: Fetch = async (_url, init) => {
    seen = { method: init?.method, headers: new Headers(init?.headers), body: await new Response(init?.body).text() };
    return new Response(null, { status: 200 });
  };
  await uploadFile(fetch, { url: "https://r2.test/put", headers: { "x-amz-checksum-sha256": "abc=" } }, file);
  expect(seen!.method).toBe("PUT");
  expect(seen!.headers.get("x-amz-checksum-sha256")).toBe("abc=");
  expect(seen!.body).toBe("payload");
  const fail: Fetch = async () => new Response("BadDigest", { status: 400 });
  expect(await uploadFile(fail, { url: "https://r2.test/put", headers: {} }, file).catch((e) => e)).toBeInstanceOf(OfflineError);
});
