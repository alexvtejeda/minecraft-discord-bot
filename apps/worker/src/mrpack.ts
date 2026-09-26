import { buildMrpack, parseLock } from "@mc/profile";
import type { WorldRow } from "./worlds";

export const modpackUrl = (origin: string, worldId: string): string => `${origin}/modpack/${worldId}.mrpack`;

/** Built on request from the world's pinned lockfile, so there's nothing in R2 to keep in sync. */
export function worldMrpack(world: WorldRow): Promise<Uint8Array> {
  const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
  const profile = JSON.parse(world.profile_json) as { description?: string };
  return buildMrpack(lock, { name: world.name, summary: profile.description });
}
