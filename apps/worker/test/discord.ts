import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { app } from "../src/index";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sign(message: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.TEST_DISCORD_JWK), { name: "Ed25519" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message))));
}

/**
 * POST a signed interaction to /interactions and wait for its waitUntil work.
 * `signTimestamp` signs a different timestamp from the one sent; `tamper` edits the body after signing.
 */
export async function postInteraction(
  payload: unknown,
  o: { signature?: string; timestamp?: string; signTimestamp?: string; tamper?: (body: string) => string; env?: Env } = {},
): Promise<{ status: number; body: any }> {
  const body = JSON.stringify(payload);
  const timestamp = o.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = o.signature ?? (await sign((o.signTimestamp ?? timestamp) + body));
  const ctx = createExecutionContext();
  const res = await app.request(
    "/interactions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
      body: o.tamper ? o.tamper(body) : body,
    },
    o.env ?? env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}
