import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { UserError } from "@mc/profile";
import { Unzip, UnzipInflate, Zip, ZipPassThrough } from "fflate";

/** What a snapshot holds. Everything else is rebuilt from the world's pinned lockfile. */
export function snapshotPaths(levelName: string): string[] {
  return [levelName, "config", "ops.json", "banned-players.json", "banned-ips.json", "usercache.json"];
}

/** Held open by a running server (locked on Windows) and meaningless on another PC. */
const SKIP = new Set(["session.lock"]);

export class ChecksumError extends UserError {}

/**
 * A deflated zip entry, compressed by zlib. fflate 0.8.3's own streaming deflate (ZipDeflate)
 * writes invalid streams for some inputs, such as a zero-padded region file, so only fflate's
 * zip container is used. Holds one file at a time in memory, never the whole zip.
 */
class ZlibDeflateEntry extends ZipPassThrough {
  private chunks: Uint8Array[] = [];

  constructor(filename: string) {
    super(filename);
    this.compression = 8;
  }

  protected override process(chunk: Uint8Array, final: boolean): void {
    this.chunks.push(chunk);
    if (!final) return;
    const out = deflateRawSync(Buffer.concat(this.chunks), { level: 6 });
    this.chunks = [];
    this.ondata!(null, new Uint8Array(out.buffer, out.byteOffset, out.byteLength), true);
  }
}

async function* walk(root: string, rel: string): AsyncGenerator<string> {
  const st = await stat(join(root, rel)).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    yield rel;
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of (await readdir(join(root, rel))).sort()) yield* walk(root, `${rel}/${entry}`);
}

export async function sha256File(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

/** Stream every file under `tops` (paths relative to root) into outFile. Never holds the whole zip in memory. */
export async function zipTree(
  root: string,
  tops: string[],
  outFile: string,
  skip: (rel: string) => boolean = () => false,
): Promise<{ sha256: string; size: number }> {
  await mkdir(dirname(outFile), { recursive: true });
  const sink = Bun.file(outFile).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  let failed: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) {
      failed = err;
      return;
    }
    hasher.update(chunk);
    size += chunk.length;
    sink.write(chunk);
  });
  for (const top of tops) {
    for await (const rel of walk(root, top)) {
      if (SKIP.has(basename(rel)) || skip(rel)) continue;
      const entry = new ZlibDeflateEntry(rel);
      zip.add(entry);
      for await (const chunk of Bun.file(join(root, rel)).stream()) entry.push(chunk);
      entry.push(new Uint8Array(0), true);
    }
  }
  zip.end();
  await sink.end();
  if (failed) throw failed;
  return { sha256: hasher.digest("hex"), size };
}

/** Stream the snapshot paths of serverDir into outFile. Never holds the whole zip in memory. */
export async function zipSnapshot(serverDir: string, levelName: string, outFile: string): Promise<{ sha256: string; size: number }> {
  return zipTree(serverDir, snapshotPaths(levelName), outFile);
}

export async function clearSnapshotPaths(serverDir: string, levelName: string): Promise<void> {
  for (const p of snapshotPaths(levelName)) await rm(join(serverDir, p), { recursive: true, force: true });
}

interface ExtractOptions {
  /** What the zip is, for messages: "world", "lobby backup". */
  what: string;
  /** Whether an entry may live under this first path segment. */
  allowTop: (top: string) => boolean;
  /** Runs after the checksum passes and before anything is written. */
  clear: () => Promise<void>;
}

/** Directory entries return null; unsafe paths and disallowed top-level names are refused. */
function entryPath(name: string, o: ExtractOptions): string | null {
  if (name.endsWith("/")) return null;
  const parts = name.split("/");
  const unsafe = parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\") || p.includes(":")) || !o.allowTop(parts[0]!);
  if (unsafe) throw new UserError(`The ${o.what} download contains an unsafe path ("${name}"), so it wasn't unpacked. Tell a maintainer.`);
  return name;
}

/** Check the sha256 first; only then clear and unpack the zip into destDir. */
export async function extractZip(zipFile: string, destDir: string, expectedSha256: string, o: ExtractOptions): Promise<void> {
  if ((await sha256File(zipFile)) !== expectedSha256) {
    throw new ChecksumError(`The downloaded ${o.what} is damaged (its sha256 doesn't match).`);
  }
  await o.clear();
  await mkdir(destDir, { recursive: true });
  const writes: Promise<unknown>[] = [];
  let failed: unknown = null;
  const unzip = new Unzip((file) => {
    let rel: string | null;
    try {
      rel = entryPath(file.name, o);
    } catch (err) {
      failed = err;
      return;
    }
    if (rel === null) return;
    const dest = join(destDir, rel);
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) {
        failed = err;
        return;
      }
      chunks.push(chunk);
      if (final) writes.push(mkdir(dirname(dest), { recursive: true }).then(() => Bun.write(dest, new Blob(chunks))));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for await (const chunk of Bun.file(zipFile).stream()) {
    unzip.push(chunk);
    if (failed) break;
  }
  if (!failed) unzip.push(new Uint8Array(0), true);
  await Promise.all(writes);
  if (failed) throw failed;
}

/** Check the sha256 first; only then replace the snapshot paths in serverDir with the zip's contents. */
export async function extractSnapshot(zipFile: string, serverDir: string, levelName: string, expectedSha256: string): Promise<void> {
  return extractZip(zipFile, serverDir, expectedSha256, {
    what: "world",
    allowTop: (top) => snapshotPaths(levelName).includes(top),
    clear: () => clearSnapshotPaths(serverDir, levelName),
  });
}
