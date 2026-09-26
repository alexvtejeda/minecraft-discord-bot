import type { Env } from "./env";

const API = "https://api.tailscale.com/api/v2";
export const PLAYER_TAG = "tag:mc-player";
export const AUTH_KEY_SECONDS = 600;

/** Tailscale refused or couldn't be reached. The message is for the Worker's logs, not for users. */
export class TailscaleError extends Error {}

type Creds = Pick<Env, "TS_OAUTH_CLIENT_ID" | "TS_OAUTH_CLIENT_SECRET">;

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new TailscaleError(`Couldn't reach Tailscale: ${(err as Error).message}`);
  }
}

async function refused(what: string, res: Response): Promise<TailscaleError> {
  return new TailscaleError(`Tailscale answered ${res.status} to ${what}: ${(await res.text()).slice(0, 300)}`);
}

/** A fresh access token per call; this runs a handful of times a week. */
async function accessToken(env: Creds): Promise<string> {
  const res = await send(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.TS_OAUTH_CLIENT_ID, client_secret: env.TS_OAUTH_CLIENT_SECRET }).toString(),
  });
  if (!res.ok) throw await refused("the token request", res);
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) throw new TailscaleError("Tailscale's token reply had no access_token.");
  return access_token;
}

/** A single-use, pre-authorized auth key that tags the device tag:mc-player. */
export async function mintAuthKey(env: Creds, description: string): Promise<string> {
  const token = await accessToken(env);
  const res = await send(`${API}/tailnet/-/keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      description,
      expirySeconds: AUTH_KEY_SECONDS,
      capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [PLAYER_TAG] } } },
    }),
  });
  if (!res.ok) throw await refused("an auth key request", res);
  const { key } = (await res.json()) as { key?: string };
  if (!key) throw new TailscaleError("Tailscale's auth key reply had no key.");
  return key;
}

/** Remove a device from the tailnet. One that's already gone counts as removed. */
export async function deleteDevice(env: Creds, nodeId: string): Promise<void> {
  const token = await accessToken(env);
  const res = await send(`${API}/device/${encodeURIComponent(nodeId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (res.ok || res.status === 404) return;
  throw await refused(`deleting device ${nodeId}`, res);
}
