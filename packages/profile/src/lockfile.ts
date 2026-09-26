import { UserError } from "./errors";
import { sha256Hex } from "./hash";
import type { Profile, Side } from "./schema";

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
