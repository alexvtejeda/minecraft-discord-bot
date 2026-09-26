import { getJson, type Http } from "./http";

export type SideSupport = "required" | "optional" | "unsupported" | "unknown";

export interface MrProject {
  id: string;
  slug: string;
  title: string;
  client_side: SideSupport;
  server_side: SideSupport;
}

export interface MrFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  hashes: { sha1: string; sha512: string };
}

export interface MrDependency {
  version_id: string | null;
  project_id: string | null;
  file_name: string | null;
  dependency_type: "required" | "optional" | "incompatible" | "embedded";
}

export interface MrVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  date_published: string;
  loaders: string[];
  game_versions: string[];
  files: MrFile[];
  dependencies: MrDependency[];
}

export interface ModrinthClient {
  getProject(ref: string): Promise<MrProject | null>;
  /** Fabric versions of a project for one Minecraft version. [] when the project is unknown. */
  getVersions(projectId: string, minecraft: string): Promise<MrVersion[]>;
  getVersion(versionId: string): Promise<MrVersion | null>;
  /** Slug of the best-matching Fabric mod for a search query, for "did you mean" hints. */
  searchSlug(query: string): Promise<string | null>;
}

export function createModrinthClient(http: Http, base = "https://api.modrinth.com/v2"): ModrinthClient {
  const enc = encodeURIComponent;
  return {
    getProject: (ref) => getJson<MrProject>(http, `${base}/project/${enc(ref)}`),
    async getVersions(projectId, minecraft) {
      const url =
        `${base}/project/${enc(projectId)}/version` +
        `?loaders=${enc(JSON.stringify(["fabric"]))}&game_versions=${enc(JSON.stringify([minecraft]))}`;
      return (await getJson<MrVersion[]>(http, url)) ?? [];
    },
    getVersion: (versionId) => getJson<MrVersion>(http, `${base}/version/${enc(versionId)}`),
    async searchSlug(query) {
      const facets = enc(JSON.stringify([["categories:fabric"], ["project_type:mod"]]));
      const res = await getJson<{ hits: { slug: string }[] }>(
        http,
        `${base}/search?query=${enc(query)}&limit=1&facets=${facets}`,
      );
      return res?.hits[0]?.slug ?? null;
    },
  };
}
