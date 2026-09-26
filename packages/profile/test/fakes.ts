import type { FabricMeta } from "../src/fabric";
import type { ModrinthClient, MrDependency, MrProject, MrVersion, SideSupport } from "../src/modrinth";
import type { MojangMeta } from "../src/mojang";
import { parseProfile, type Profile } from "../src/schema";

export function makeVersion(projectId: string, o: Partial<MrVersion> & { id: string }): MrVersion {
  return {
    project_id: projectId,
    version_number: o.id,
    version_type: "release",
    date_published: "2026-09-01T00:00:00Z",
    loaders: ["fabric"],
    game_versions: ["26.3"],
    dependencies: [],
    files: [
      {
        url: `https://cdn.modrinth.com/data/${projectId}/versions/${o.id}/${projectId}-${o.id}.jar`,
        filename: `${projectId}-${o.id}.jar`,
        primary: true,
        size: 100,
        hashes: { sha1: `sha1-${o.id}`, sha512: `sha512-${o.id}` },
      },
    ],
    ...o,
  };
}

export function dep(projectId: string, type: MrDependency["dependency_type"] = "required"): MrDependency {
  return { project_id: projectId, version_id: null, file_name: null, dependency_type: type };
}

/** In-memory Modrinth. Project ids are the slug in upper case, e.g. "lithium" → "LITHIUM". */
export class FakeModrinth implements ModrinthClient {
  projects = new Map<string, MrProject>();
  versions = new Map<string, MrVersion[]>();
  searches = new Map<string, string>();

  add(slug: string, versions: Omit<Partial<MrVersion>, "project_id">[] = [{}], sides: { client?: SideSupport; server?: SideSupport } = {}) {
    const id = slug.toUpperCase();
    this.projects.set(id, {
      id,
      slug,
      title: slug,
      client_side: sides.client ?? "required",
      server_side: sides.server ?? "required",
    });
    this.versions.set(id, versions.map((v, i) => makeVersion(id, { id: `${slug}-v${i + 1}`, ...v })));
    return id;
  }

  async getProject(ref: string) {
    return this.projects.get(ref) ?? [...this.projects.values()].find((p) => p.slug === ref) ?? null;
  }
  async getVersions(projectId: string, minecraft: string) {
    return (this.versions.get(projectId) ?? []).filter((v) => v.game_versions.includes(minecraft));
  }
  async getVersion(versionId: string) {
    for (const list of this.versions.values()) {
      const hit = list.find((v) => v.id === versionId);
      if (hit) return hit;
    }
    return null;
  }
  async searchSlug(query: string) {
    return this.searches.get(query) ?? null;
  }
}

export const fakeFabric: FabricMeta = {
  loaderVersions: async (mc) => (mc === "26.3" ? [{ version: "0.19.5", stable: true }] : []),
  latestStableInstaller: async () => "1.1.2",
};

export const fakeMojang: MojangMeta = { javaMajor: async () => 25 };

export function makeProfile(over: Record<string, unknown> = {}): Profile {
  return parseProfile(
    {
      name: "test",
      description: "t",
      minecraft: "26.3",
      loader: { fabric: "latest-stable" },
      memory: { min: "2G", max: "4G" },
      mods: [{ modrinth: "lithium", side: "server" }],
      ...over,
    },
    "test.json",
  );
}
