import { AGENT_VERSION_HEADER } from "@mc/protocol";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env";
import { ApiError } from "./errors";

export const OUTDATED = "mc-host is out of date. Run `/setup host` in Discord to update.";

function parse(v: string | undefined): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  return m ? m.slice(1).map(Number) : null;
}

/** "0.10.0" ≥ "0.9.9". A missing or unparseable version counts as too old. */
export function atLeast(version: string | undefined, min: string): boolean {
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

export const versionCheck = createMiddleware<AppEnv>(async (c, next) => {
  if (c.env.MIN_AGENT_VERSION && !atLeast(c.req.header(AGENT_VERSION_HEADER), c.env.MIN_AGENT_VERSION)) {
    throw new ApiError("outdated", OUTDATED);
  }
  await next();
});
