import { buildMrpack, isUploadedJar, parseLock, type ExtraFile } from "@mc/profile";
import type { Env } from "./env";
import { jarKey } from "./jars";
import type { WorldRow } from "./worlds";

export const modpackUrl = (origin: string, worldId: string): string => `${origin}/modpack/${worldId}.mrpack`;

/**
 * Built on request from the world's pinned lockfile. Modrinth mods are links; uploaded jars
 * that players need are read from R2 and bundled under overrides/mods/.
 */
export async function worldMrpack(env: Pick<Env, "BUCKET">, world: WorldRow): Promise<Uint8Array> {
  const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
  const profile = JSON.parse(world.profile_json) as { description?: string };
  const extras: ExtraFile[] = [];
  for (const f of lock.files) {
    if (!isUploadedJar(f) || f.side === "server") continue;
    const obj = await env.BUCKET.get(jarKey(f.sha512));
    if (!obj) throw new Error(`${world.name}'s lockfile pins ${f.filename} (jar ${f.sha512.slice(0, 12)}), but it isn't in R2`);
    extras.push({ path: `mods/${f.filename}`, data: new Uint8Array(await obj.arrayBuffer()) });
  }
  return buildMrpack(lock, { name: world.name, summary: profile.description }, extras);
}
