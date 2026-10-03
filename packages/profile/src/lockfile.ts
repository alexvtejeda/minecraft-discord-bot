import { UserError } from "./errors";
import { sha256Hex } from "./hash";
import type { JarInfo } from "./jarcheck";
import type { JarEntry, Profile, Side } from "./schema";

export interface LockEntry {
  slug: string;
  projectId: string;
  versionId: string;
  versionNumber: string;
  filename: string;
  url: string;
  sha1: string;
  sha512: string;
  size: number;
  side: Side;
  /** Players may untick it in the launcher. Always false for "server". */
  clientOptional: boolean;
  /** Pulled in as a dependency, not listed in the profile. */
  auto: boolean;
  /** Only a beta or alpha build was available. */
  prerelease: boolean;
  /** "jar": uploaded to the Worker rather than from Modrinth; url is then relative to the Worker. */
  source?: "jar";
}

export interface Lockfile {
  lockfileVersion: 1;
  profile: string;
  /** sha256 of the parsed profile. Build commands refuse a lockfile whose hash doesn't match. */
  profileHash: string;
  minecraft: string;
  javaMajor: number;
  fabricLoader: string;
  fabricInstaller: string;
  files: LockEntry[];
}

export function serializeLock(lock: Lockfile): string {
  return JSON.stringify(lock, null, 2) + "\n";
}

export function parseLock(text: string, source: string): Lockfile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UserError(`${source} isn't valid JSON. Delete it and run "mc-host profile resolve" again.`);
  }
  const lock = data as Partial<Lockfile> | null;
  if (!lock || lock.lockfileVersion !== 1 || !Array.isArray(lock.files)) {
    throw new UserError(`${source} isn't a lockfile this version of mc-host understands. Run "mc-host profile resolve" again.`);
  }
  return lock as Lockfile;
}

export function profileHash(profile: Profile): Promise<string> {
  return sha256Hex(JSON.stringify(profile));
}

export const jarUrl = (sha512: string): string => `jars/${sha512}`;

export const isUploadedJar = (f: LockEntry): boolean => f.source === "jar";

export function jarLockEntry(j: JarEntry, info: JarInfo): LockEntry {
  return {
    slug: j.jar,
    projectId: "jar",
    versionId: j.sha512.slice(0, 12),
    versionNumber: info.version ?? "unknown",
    filename: j.filename,
    url: jarUrl(j.sha512),
    sha1: info.sha1,
    sha512: j.sha512,
    size: info.size,
    side: j.side,
    clientOptional: false,
    auto: false,
    prerelease: false,
    source: "jar",
  };
}
