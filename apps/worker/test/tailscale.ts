import { vi } from "vitest";

export interface TsCall {
  url: string;
  method: string;
  auth: string | null;
  body: any;
}

/**
 * Fake the Tailscale API for the rest of the test and record each call. Pair with
 * afterEach(vi.restoreAllMocks). `deleteStatus` maps a node id to the status its DELETE gets.
 * `deviceTags` maps a node id to the tags its GET reports (null: not found); others are tag:mc-player.
 */
export function fakeTailscale(
  o: { mint?: "fail"; deleteStatus?: Record<string, number>; deviceTags?: Record<string, string[] | null> } = {},
): TsCall[] {
  const calls: TsCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as Request | string, init);
    const text = await req.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    calls.push({ url: req.url, method: req.method, auth: req.headers.get("Authorization"), body });
    if (req.url.endsWith("/oauth/token")) return Response.json({ access_token: "ts-access", token_type: "Bearer", expires_in: 3600 });
    if (req.url.endsWith("/tailnet/-/keys")) {
      return o.mint === "fail" ? Response.json({ message: "requested tags are invalid" }, { status: 403 }) : Response.json({ id: "k1", key: "tskey-auth-test" });
    }
    const m = /\/device\/([^/]+)$/.exec(req.url);
    if (m && req.method === "GET") {
      const tags = o.deviceTags?.[decodeURIComponent(m[1]!)];
      if (tags === null) return Response.json({ message: "not found" }, { status: 404 });
      return Response.json({ nodeId: decodeURIComponent(m[1]!), tags: tags ?? ["tag:mc-player"] });
    }
    if (m && req.method === "DELETE") {
      const status = o.deleteStatus?.[decodeURIComponent(m[1]!)] ?? 200;
      return new Response(status === 200 ? null : JSON.stringify({ message: "nope" }), { status });
    }
    return new Response("unexpected request", { status: 500 });
  });
  return calls;
}
