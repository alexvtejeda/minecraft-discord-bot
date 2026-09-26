import type { Fetch, Http } from "../src/http";

/** A fetch that answers from a URL → JSON body map. Unknown URLs get 404. */
export function routeFetch(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (!(url in routes)) return new Response("not found", { status: 404 });
    return Response.json(routes[url]);
  };
  return { fetch, calls };
}

export function testHttp(fetch: Fetch): Http {
  return { fetch, userAgent: "test-agent", sleep: async () => {} };
}
