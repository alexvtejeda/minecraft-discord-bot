import { inspectJar, type JarInfo, type JarTarget } from "@mc/profile";
import type { Env } from "./env";
import { ApiError } from "./errors";

export const MAX_JAR_BYTES = 32 * 1024 * 1024;
export const jarKey = (sha512: string): string => `jars/${sha512}.jar`;

interface JarRow {
  sha512: string;
  sha1: string;
  size: number;
  filename: string;
  mod_id: string | null;
  version: string | null;
  minecraft_range: string | null;
  java_range: string | null;
  depends_json: string;
}

const toInfo = (r: JarRow): JarInfo => ({
  sha512: r.sha512,
  sha1: r.sha1,
  size: r.size,
  filename: r.filename,
  modId: r.mod_id,
  version: r.version,
  minecraftRange: r.minecraft_range,
  javaRange: r.java_range,
  depends: JSON.parse(r.depends_json) as string[],
});

export async function getJar(db: D1Database, sha512: string): Promise<JarInfo | null> {
  const row = await db.prepare("SELECT * FROM jars WHERE sha512 = ?").bind(sha512).first<JarRow>();
  return row ? toInfo(row) : null;
}

/**
 * Check a jar against the target and keep it. The object goes to R2 before the row, so a row
 * always has its bytes. A jar that's already stored is still checked against this target.
 */
export async function storeJar(
  env: Pick<Env, "DB" | "BUCKET">,
  o: { bytes: Uint8Array; filename: string; target: JarTarget; by: string; now: number; expectSha512?: string },
): Promise<{ jar: JarInfo; created: boolean }> {
  if (o.bytes.length > MAX_JAR_BYTES) {
    throw new ApiError("bad_request", `${o.filename} is over ${MAX_JAR_BYTES / 1024 / 1024} MB, which is bigger than any mod should be.`);
  }
  const { problems, ...info } = await inspectJar(o.bytes, o.filename, o.target);
  if (o.expectSha512 && info.sha512 !== o.expectSha512) {
    throw new ApiError("upload_missing", "The upload doesn't match its sha512. Upload it again.");
  }
  if (problems.length) throw new ApiError("bad_request", problems.join(" "));
  const existing = await getJar(env.DB, info.sha512);
  if (existing) return { jar: existing, created: false };
  await env.BUCKET.put(jarKey(info.sha512), o.bytes);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO jars (sha512, sha1, size, filename, mod_id, version, minecraft_range, java_range, depends_json, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(info.sha512, info.sha1, info.size, info.filename, info.modId, info.version, info.minecraftRange, info.javaRange, JSON.stringify(info.depends), o.by, o.now)
    .run();
  return { jar: info, created: true };
}
