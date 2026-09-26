import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { UserError } from "@mc/profile";
import { Unzip, UnzipInflate } from "fflate";

/** Unpack a zip into dest. An entry that would land outside dest fails the whole unpack. */
export async function unzipTo(zipFile: string, dest: string): Promise<void> {
  const writes: Promise<unknown>[] = [];
  let failed: unknown = null;
  const unzip = new Unzip((file) => {
    const rel = normalize(file.name);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || /^[a-zA-Z]:/.test(file.name)) {
      failed = new UserError(`${zipFile} has an unsafe entry: ${file.name}`);
      return;
    }
    if (file.name.endsWith("/")) {
      writes.push(mkdir(join(dest, rel), { recursive: true }));
      return;
    }
    const out = join(dest, rel);
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) {
        failed = err;
        return;
      }
      chunks.push(chunk);
      if (final) writes.push(mkdir(dirname(out), { recursive: true }).then(() => Bun.write(out, new Blob(chunks))));
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
