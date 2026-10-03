import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isUploadedJar, sha256Hex, sha512Hex, UserError, type Fetch, type LockEntry } from "@mc/profile";

export interface DownloadOptions {
  fetch: Fetch;
  cacheDir: string;
  userAgent: string;
}

/**
 * Download a file into the content cache and return its path.
 * With a sha512, the cached copy is re-checked and every download is verified (one retry).
 * Without one (the Fabric launcher), the file is cached by URL.
 */
export async function fetchVerified(url: string, sha512: string | undefined, o: DownloadOptions): Promise<string> {
  const key = sha512 ?? `url-${await sha256Hex(url)}`;
  const path = join(o.cacheDir, "files", key.slice(0, 2), key);
  if (existsSync(path) && (!sha512 || (await sha512Hex(await readFile(path))) === sha512)) return path;

  await mkdir(dirname(path), { recursive: true });
  const name = decodeURIComponent(basename(new URL(url).pathname));
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await o.fetch(url, { headers: { "User-Agent": o.userAgent } });
    } catch (err) {
      if (attempt < 2) continue;
      throw new UserError(`Couldn't download ${name} (${(err as Error).message}). Check your internet connection and try again.`);
    }
    if (!res.ok) {
      throw new UserError(`Couldn't download ${name} (HTTP ${res.status}). Check your internet connection and try again.`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (sha512 && (await sha512Hex(data)) !== sha512) continue;
    const tmp = `${path}.part`;
    await writeFile(tmp, data);
    await rename(tmp, path);
    return path;
  }
  throw new UserError(
    `${name} was corrupted twice while downloading (its hash didn't match). Try again later. If it keeps happening, run "mc-host profile resolve" again, because the file on Modrinth may have changed.`,
  );
}

/** The Worker that serves uploaded jars, and a hosting token or the admin secret for it. */
export interface JarSource {
  workerUrl: string;
  secret: string;
}

/** Where a lock entry downloads from: Modrinth's CDN as-is, uploaded jars from the Worker with auth. */
export function sourceFor(f: LockEntry, fetch: Fetch, jars: JarSource | undefined): { url: string; fetch: Fetch } {
  if (!isUploadedJar(f)) return { url: f.url, fetch };
  if (!jars) {
    throw new UserError(`${f.filename} is an uploaded jar, so building needs the Worker: set MC_WORKER_URL with MC_TOKEN or MC_ADMIN_SECRET.`);
  }
  const authed: Fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${jars.secret}`);
    return fetch(input, { ...init, headers });
  };
  return { url: `${jars.workerUrl.replace(/\/+$/, "")}/${f.url}`, fetch: authed };
}
