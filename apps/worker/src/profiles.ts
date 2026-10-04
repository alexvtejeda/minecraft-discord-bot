import type { Lockfile, Profile } from "@mc/profile";
import cst from "../../../profiles/cst.json";
import cstLock  from "../../../profiles/cst.lock.json";
import adventure from "../../../profiles/adventure.json";
import adventureLock from "../../../profiles/adventure.lock.json";
import vanillaPlus from "../../../profiles/vanilla-plus.json";
import vanillaPlusLock from "../../../profiles/vanilla-plus.lock.json";
import { validateWorldFiles } from "./worlds";

/**
 * Profiles bundled at deploy time. To add one, import its pair here; the test in
 * world-new.vitest.ts checks every pair still matches, so a profile edited without
 * re-running `mc-host profile resolve` fails the tests instead of /world new.
 */
const RAW: [unknown, unknown][] = [
  [cst, cstLock],
  [adventure, adventureLock],
  [vanillaPlus, vanillaPlusLock],
];

export const BUNDLED_NAMES: string[] = RAW.map(([p]) => (p as { name: string }).name);

export interface Bundled {
  name: string;
  profile: Profile;
  lock: Lockfile;
}

let cache: Promise<Bundled[]> | undefined;

export function bundledProfiles(): Promise<Bundled[]> {
  cache ??= Promise.all(
    RAW.map(async ([p, l]) => {
      const { profile, lock } = await validateWorldFiles(p, l);
      return { name: profile.name, profile, lock };
    }),
  );
  return cache;
}

export async function bundledProfile(name: string): Promise<Bundled | null> {
  return (await bundledProfiles()).find((b) => b.name === name) ?? null;
}

/** The seed lives in the world's stored profile; the agent writes it to server.properties. */
export function withSeed(profile: Profile, seed: string | number | boolean | undefined): Profile {
  if (seed === undefined || seed === "") return profile;
  return { ...profile, properties: { ...profile.properties, "level-seed": String(seed) } };
}
