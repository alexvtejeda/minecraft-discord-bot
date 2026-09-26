import { UserError } from "./errors";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Http {
  fetch: Fetch;
  userAgent: string;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number) => 500 * 2 ** attempt;

/** GET a JSON document. Returns null on 404. Retries 429, 5xx and network errors with backoff. */
export async function getJson<T>(http: Http, url: string): Promise<T | null> {
  const sleep = http.sleep ?? defaultSleep;
  const attempts = http.maxAttempts ?? 5;
  let last = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const isLast = attempt === attempts - 1;
    let res: Response;
    try {
      res = await http.fetch(url, { headers: { "User-Agent": http.userAgent, Accept: "application/json" } });
    } catch (err) {
      last = (err as Error).message;
      if (!isLast) await sleep(backoff(attempt));
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as T;
    last = `HTTP ${res.status}`;
    if (res.status !== 429 && res.status < 500) throw new Error(`GET ${url} failed: ${last}`);
    const reset = Number(res.headers.get("X-Ratelimit-Reset"));
    if (!isLast) await sleep(res.status === 429 && reset > 0 ? reset * 1000 : backoff(attempt));
  }
  throw new UserError(`${new URL(url).host} isn't responding (${last}). Try again in a few minutes.`);
}
