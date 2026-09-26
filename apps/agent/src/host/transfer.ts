import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Fetch } from "@mc/profile";
import { OfflineError } from "./api";

export async function downloadTo(fetch: Fetch, url: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new OfflineError(`Couldn't download the world (${(err as Error).message}). Check your internet connection and try again.`);
  }
  if (!res.ok || !res.body) throw new OfflineError(`Couldn't download the world (HTTP ${res.status}). Try again in a few minutes.`);
  await mkdir(dirname(dest), { recursive: true });
  const sink = Bun.file(dest).writer();
  // A read loop rather than `for await`: Bun 1.3's async iterator over a fetch body can throw
  // "undefined is not a function" (seen against wrangler dev's gzip responses).
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sink.write(value);
  }
  await sink.end();
}

export async function uploadFile(fetch: Fetch, target: { url: string; headers: Record<string, string> }, file: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(target.url, { method: "PUT", headers: target.headers, body: Bun.file(file) });
  } catch (err) {
    throw new OfflineError(`Couldn't upload the world (${(err as Error).message}).`);
  }
  if (!res.ok) throw new OfflineError(`Couldn't upload the world (HTTP ${res.status}).`);
}
