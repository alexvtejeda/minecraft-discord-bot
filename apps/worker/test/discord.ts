import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { app } from "../src/index";
import type { RequestMeta } from "../src/discord/registry";
import { vi } from "vitest";
import { envWith } from "./helpers";

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

export const ALEX = "100000000000000001";
export const SAM = "100000000000000002";
export const MAINTAINER_ROLE = "500000000000000001";

type Who = { user?: string; maintainer?: boolean; noMember?: boolean };
let seq = 0;

function base(type: number, who: Who) {
  const user = { id: who.user ?? ALEX, username: "someone" };
  return {
    id: `90000000000000${++seq}`,
    application_id: env.DISCORD_APP_ID,
    type,
    token: `interaction-token-${seq}`,
    version: 1,
    guild_id: env.DISCORD_GUILD_ID,
    ...(who.noMember ? { user } : { member: { user, roles: who.maintainer ? [MAINTAINER_ROLE] : [] } }),
  };
}

function optionList(options: Record<string, string | number | boolean>, focused?: string) {
  return Object.entries(options).map(([name, value]) => ({
    name,
    type: typeof value === "number" ? 4 : typeof value === "boolean" ? 5 : 3,
    value,
    ...(name === focused ? { focused: true } : {}),
  }));
}

function commandData(path: string, options: Record<string, string | number | boolean>, focused?: string) {
  const [name, sub] = path.split(" ");
  const opts = optionList(options, focused);
  return { id: "1", name, type: 1, options: sub ? [{ name: sub, type: 1, options: opts }] : opts };
}

export const slash = (path: string, options: Record<string, string | number | boolean> = {}, who: Who = {}) => ({
  ...base(2, who),
  data: commandData(path, options),
});

export const autocomplete = (path: string, options: Record<string, string | number | boolean>, focused: string, who: Who = {}) => ({
  ...base(4, who),
  data: commandData(path, options, focused),
});

export const button = (customId: string, who: Who = {}) => ({
  ...base(3, who),
  message: { id: "800000000000000001", content: "preview" },
  data: { custom_id: customId, component_type: 2 },
});

export const requestMeta = (over: Partial<RequestMeta> = {}): RequestMeta => ({
  env,
  exec: createExecutionContext(),
  requestUrl: "https://bot.test/interactions",
  now: 1_000_000,
  ...over,
});

export const ANNOUNCE_CHANNEL = "400000000000000001";
export const announceEnv = () => envWith({ ANNOUNCE_CHANNEL_ID: ANNOUNCE_CHANNEL });

export interface DiscordCall {
  url: string;
  method: string;
  auth: string | null;
  body: any;
}

/** Replace fetch for the rest of the test and record each call. Pair with afterEach(vi.restoreAllMocks). */
export function captureDiscord(o: { fail?: boolean } = {}): DiscordCall[] {
  const calls: DiscordCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as Request | string, init);
    calls.push({ url: req.url, method: req.method, auth: req.headers.get("Authorization"), body: await req.json().catch(() => null) });
    if (o.fail) throw new Error("Discord is down");
    return Response.json({ id: "1" });
  });
  return calls;
}
