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
 */
export function fakeTailscale(o: { mint?: "fail"; deleteStatus?: Record<string, number> } = {}): TsCall[] {
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
    if (m && req.method === "DELETE") {
      const status = o.deleteStatus?.[decodeURIComponent(m[1]!)] ?? 200;
      return new Response(status === 200 ? null : JSON.stringify({ message: "nope" }), { status });
    }
    return new Response("unexpected request", { status: 500 });
  });
  return calls;
}
