import { UserError } from "./errors";
import { getJson, type Http } from "./http";

const FABRIC_META = "https://meta.fabricmc.net/v2";

export interface FabricMeta {
  loaderVersions(minecraft: string): Promise<{ version: string; stable: boolean }[]>;
  latestStableInstaller(): Promise<string>;
}

export function createFabricMeta(http: Http, base = FABRIC_META): FabricMeta {
  return {
    async loaderVersions(minecraft) {
      const data = await getJson<{ loader: { version: string; stable: boolean } }[]>(
        http,
        `${base}/versions/loader/${encodeURIComponent(minecraft)}`,
      );
      return (data ?? []).map((d) => d.loader);
    },
    async latestStableInstaller() {
      const data = (await getJson<{ version: string; stable: boolean }[]>(http, `${base}/versions/installer`)) ?? [];
      const stable = data.find((d) => d.stable);
      if (!stable) throw new UserError("Fabric has no stable installer listed right now. Try again later.");
      return stable.version;
    },
  };
}

/** Resolve "latest-stable" or check that an exact loader version exists for this Minecraft version. */
export async function chooseLoader(meta: FabricMeta, minecraft: string, wanted: string): Promise<string> {
  const loaders = await meta.loaderVersions(minecraft);
  if (loaders.length === 0) {
    throw new UserError(`Fabric doesn't support Minecraft ${minecraft} yet. Pick another version or wait for Fabric to update.`);
  }
  if (wanted === "latest-stable") {
    const stable = loaders.find((l) => l.stable);
    if (!stable) throw new UserError(`Fabric has no stable loader for Minecraft ${minecraft} yet.`);
    return stable.version;
  }
  if (!loaders.some((l) => l.version === wanted)) {
    throw new UserError(
      `Fabric loader ${wanted} doesn't exist for Minecraft ${minecraft}. Use "latest-stable" or a version listed at https://fabricmc.net/develop/.`,
    );
  }
  return wanted;
}

export function serverLauncherUrl(minecraft: string, loader: string, installer: string): string {
  return `${FABRIC_META}/versions/loader/${minecraft}/${loader}/${installer}/server/jar`;
}
