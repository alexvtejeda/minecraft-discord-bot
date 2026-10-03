import { strToU8, zipSync, type Zippable } from "fflate";
import { UserError } from "./errors";
import { sha256Hex } from "./hash";
import { isUploadedJar, serializeLock, type LockEntry, type Lockfile } from "./lockfile";

export type EnvNeed = "required" | "optional" | "unsupported";

export interface MrpackFile {
  path: string;
  hashes: { sha1: string; sha512: string };
  env: { client: EnvNeed; server: EnvNeed };
  downloads: string[];
  fileSize: number;
}

export interface MrpackIndex {
  formatVersion: 1;
  game: "minecraft";
  versionId: string;
  name: string;
  summary?: string;
  files: MrpackFile[];
  dependencies: Record<string, string>;
}

/** A file bundled inside the pack under overrides/: uploaded jars, which only the Worker has. */
export interface ExtraFile {
  path: string;
  data: Uint8Array;
}

// Fixed timestamp so the same lockfile always produces the same bytes.
const FIXED_MTIME = new Date("2000-01-01T00:00:00Z");

/** env for the .mrpack, or null for files that stay on the server. */
export function clientEnv(f: LockEntry): MrpackFile["env"] | null {
  if (f.side === "server") return null;
  if (f.side === "both") return { client: f.clientOptional ? "optional" : "required", server: "required" };
  return { client: f.clientOptional ? "optional" : "required", server: "unsupported" };
}

export async function mrpackIndex(lock: Lockfile, meta: { name: string; summary?: string }): Promise<MrpackIndex> {
  const files = lock.files.flatMap((f): MrpackFile[] => {
    if (isUploadedJar(f)) return [];
    const env = clientEnv(f);
    if (!env) return [];
    return [
      {
        path: `mods/${f.filename}`,
        hashes: { sha1: f.sha1, sha512: f.sha512 },
        env,
        downloads: [f.url],
        fileSize: f.size,
      },
    ];
  });
  const hash = (await sha256Hex(serializeLock(lock))).slice(0, 12);
  return {
    formatVersion: 1,
    game: "minecraft",
    versionId: `${lock.minecraft}-${hash}`,
    name: meta.name,
    ...(meta.summary ? { summary: meta.summary } : {}),
    files,
    dependencies: { minecraft: lock.minecraft, "fabric-loader": lock.fabricLoader },
  };
}

export async function buildMrpack(
  lock: Lockfile,
  meta: { name: string; summary?: string },
  extras: ExtraFile[] = [],
): Promise<Uint8Array> {
  const index = await mrpackIndex(lock, meta);
  const zip: Zippable = {
    "modrinth.index.json": [strToU8(JSON.stringify(index, null, 2)), { mtime: FIXED_MTIME }],
  };
  for (const e of extras) {
    if (e.path.startsWith("/") || e.path.split("/").includes("..")) throw new UserError(`Bad override path: ${e.path}`);
    zip[`overrides/${e.path}`] = [e.data, { mtime: FIXED_MTIME }];
  }
  return zipSync(zip, { level: 6 });
}

/** True when a vanilla client can join: no file is required on the client. */
export function isVanillaCompatible(lock: Lockfile): boolean {
  return !lock.files.some((f) => f.side !== "server" && !f.clientOptional);
}
