import { EnrollDeviceRequestSchema, EnrollRequestSchema, type EnrollResponse, type Ok } from "@mc/protocol";
import { Hono } from "hono";
import script from "../../../../scripts/install.ps1";
import { claimDeviceReport, consumeEnrollment, normalizeCode, pendingEnrollment, recentlyUsedEnrollment, tailnetHostname, type Mode } from "../enroll";
import type { AppEnv } from "../env";
import { ApiError, readBody } from "../errors";
import { deviceTags, mintAuthKey, PLAYER_TAG, TailscaleError } from "../tailscale";
import { ensurePlayer, mintToken } from "../users";

export const EXPIRED = "This setup link expired. Run /setup in Discord again.";
export const NO_KEY = "Couldn't create your network key. Try again in a minute. If it keeps failing, tell a maintainer.";
export const NOT_YOURS = "This PC's Tailscale device isn't one this setup link can claim. Ask a maintainer for help.";

/** A PowerShell single-quoted string literal. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function installScript(origin: string, code: string, mode: Mode): string {
  return script.replace("'__WORKER_URL__'", psQuote(origin)).replace("'__CODE__'", psQuote(code)).replace("'__MODE__'", psQuote(mode));
}

export const expiredScript = (): string => `Write-Host ${psQuote(EXPIRED)} -ForegroundColor Yellow\n`;

/** GET /s/:code: always 200, because `irm` would print a red error for anything else. */
export const setupScript = new Hono<AppEnv>();
setupScript.get("/:code", async (c) => {
  const raw = c.req.param("code");
  const row = await pendingEnrollment(c.env.DB, raw, Date.now());
  const body = row ? installScript(new URL(c.req.url).origin, normalizeCode(raw)!, row.mode) : expiredScript();
  return c.text(body, 200, { "Cache-Control": "no-store" });
});

export const enroll = new Hono<AppEnv>();

enroll.post("/", async (c) => {
  const req = await readBody(c, EnrollRequestSchema);
  const now = Date.now();
  const row = await pendingEnrollment(c.env.DB, req.code, now);
  if (!row) throw new ApiError("expired", EXPIRED);
  const hostname = tailnetHostname(row.name, row.discord_id);
  // Mint before using the code up, so a Tailscale hiccup leaves the same line usable.
  let authKey: string | undefined;
  if (req.join) {
    try {
      authKey = await mintAuthKey(c.env, `setup ${hostname}`);
    } catch (err) {
      if (!(err instanceof TailscaleError)) throw err;
      console.error(err.message);
      throw new ApiError("upstream", NO_KEY);
    }
  }
  // Losing this race wastes the key, which is single-use and expires in 10 minutes anyway.
  if (!(await consumeEnrollment(c.env.DB, row, now))) throw new ApiError("expired", EXPIRED);
  let token: string | undefined;
  if (row.mode === "host") token = await mintToken(c.env.DB, row.discord_id, row.name, now);
  else await ensurePlayer(c.env.DB, row.discord_id, row.name, now);
  const body: EnrollResponse = { hostname, ...(authKey ? { authKey } : {}), ...(token ? { token } : {}) };
  return c.json(body);
});

enroll.post("/device", async (c) => {
  const req = await readBody(c, EnrollDeviceRequestSchema);
  const now = Date.now();
  const row = await recentlyUsedEnrollment(c.env.DB, req.code, now);
  if (!row) throw new ApiError("expired", EXPIRED);
  // Revoke deletes what's recorded here, so a code may only claim a Minecraft device nobody else has.
  const owner = await c.env.DB.prepare("SELECT discord_id FROM devices WHERE node_id = ?").bind(req.nodeId).first<string>("discord_id");
  if (owner !== null && owner !== row.discord_id) throw new ApiError("conflict", NOT_YOURS);
  let tags: string[] | null;
  try {
    tags = await deviceTags(c.env, req.nodeId);
  } catch (err) {
    if (!(err instanceof TailscaleError)) throw err;
    console.error(err.message);
    throw new ApiError("upstream", "Couldn't check this PC with Tailscale. Tell a maintainer.");
  }
  if (!tags?.includes(PLAYER_TAG)) throw new ApiError("conflict", NOT_YOURS);
  if (!(await claimDeviceReport(c.env.DB, row, now))) throw new ApiError("expired", EXPIRED);
  await c.env.DB.prepare(
    `INSERT INTO devices (node_id, discord_id, hostname, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (node_id) DO UPDATE SET hostname = excluded.hostname WHERE devices.discord_id = excluded.discord_id`,
  )
    .bind(req.nodeId, row.discord_id, tailnetHostname(row.name, row.discord_id), now)
    .run();
  const body: Ok = { ok: true };
  return c.json(body);
});
