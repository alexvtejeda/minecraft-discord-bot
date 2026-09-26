import { UserError } from "./errors";
import { getJson, type Http } from "./http";

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

export interface MojangMeta {
  javaMajor(minecraft: string): Promise<number>;
}

export function createMojangMeta(http: Http, manifestUrl = MANIFEST): MojangMeta {
  return {
    async javaMajor(minecraft) {
      const manifest = await getJson<{ versions: { id: string; type: string; url: string }[] }>(http, manifestUrl);
      const entry = manifest?.versions.find((v) => v.id === minecraft);
      if (!entry) throw new UserError(`Minecraft ${minecraft} isn't in Mojang's version list. Check the "minecraft" field.`);
      if (entry.type !== "release") {
        throw new UserError(`Minecraft ${minecraft} is a ${entry.type}, not a release. Profiles only use releases.`);
      }
      const detail = await getJson<{ javaVersion?: { majorVersion: number } }>(http, entry.url);
      const major = detail?.javaVersion?.majorVersion;
      if (!major) throw new UserError(`Mojang's metadata for ${minecraft} doesn't say which Java it needs.`);
      return major;
    },
  };
}
