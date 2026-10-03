import { Hono } from "hono";
import { agentOrAdminAuth } from "../auth";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { jarKey } from "../jars";

/** Uploaded mod jars for server builds. Never public: the lockfiles naming them are in a public repo. */
export const jars = new Hono<AppEnv>();
jars.use("*", agentOrAdminAuth);

jars.get("/:sha512", async (c) => {
  const sha512 = c.req.param("sha512");
  const obj = /^[0-9a-f]{128}$/.test(sha512) ? await c.env.BUCKET.get(jarKey(sha512)) : null;
  if (!obj) throw new ApiError("not_found", "That jar isn't uploaded. A maintainer can add it with /mod upload.");
  return new Response(obj.body, { headers: { "Content-Type": "application/java-archive", "Content-Length": String(obj.size) } });
});
