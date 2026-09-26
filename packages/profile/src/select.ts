import { UserError } from "./errors";
import type { MrFile, MrVersion } from "./modrinth";

/** Newest release, else newest beta, else newest alpha. A pin matches version_number or id. */
export function pickVersion(versions: MrVersion[], pin?: string): MrVersion | null {
  const fabric = versions.filter((v) => v.loaders.includes("fabric"));
  if (pin) return fabric.find((v) => v.version_number === pin || v.id === pin) ?? null;
  const newest = [...fabric].sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published));
  for (const type of ["release", "beta", "alpha"] as const) {
    const hit = newest.find((v) => v.version_type === type);
    if (hit) return hit;
  }
  return null;
}

export function primaryFile(version: MrVersion, title: string): MrFile {
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) throw new UserError(`${title} ${version.version_number} has no downloadable file on Modrinth.`);
  return file;
}
