import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { base64ToHex } from "../storage";

export const dev = new Hono<AppEnv>();

dev.use("*", async (c, next) => {
  if (c.env.DEV_R2_PROXY !== "1") throw new ApiError("not_found", "There's nothing at this address.");
  await next();
});

const keyOf = (path: string) => path.slice("/dev/r2/".length).split("/").map(decodeURIComponent).join("/");

dev.get("/r2/*", async (c) => {
  const obj = await c.env.BUCKET.get(keyOf(c.req.path));
  if (!obj) throw new ApiError("not_found", "No such object.");
  return new Response(obj.body, { headers: { "Content-Length": String(obj.size) } });
});

dev.put("/r2/*", async (c) => {
  const b64 = c.req.header("x-amz-checksum-sha256");
  if (!b64) throw new ApiError("bad_request", "Missing x-amz-checksum-sha256.");
  const body = await c.req.arrayBuffer();
  try {
    await c.env.BUCKET.put(keyOf(c.req.path), body, { sha256: base64ToHex(b64) });
  } catch {
    throw new ApiError("bad_request", "BadDigest: the upload didn't match its sha256.");
  }
  return c.body(null, 200);
});
