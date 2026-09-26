import { UserError } from "./errors";
import { chooseLoader, type FabricMeta } from "./fabric";
import { profileHash, type LockEntry, type Lockfile } from "./lockfile";
import type { ModrinthClient, MrProject, MrVersion } from "./modrinth";
import type { MojangMeta } from "./mojang";
import {
  clampToProject,
  mergePlacement,
  placementOf,
  samePlacement,
  sideFromMetadata,
  sideOf,
  type Placement,
} from "./placement";
import type { Profile, Side } from "./schema";
import { pickVersion, primaryFile } from "./select";

export interface ResolveDeps {
  modrinth: ModrinthClient;
  fabric: FabricMeta;
  mojang: MojangMeta;
}

export interface WaitingStatus {
  slug: string;
  ready: boolean;
  suggestedSide?: Side;
}

export interface ResolveResult {
  lock: Lockfile;
  warnings: string[];
  waiting: WaitingStatus[];
}

interface Node {
  project: MrProject;
  version: MrVersion;
  placement: Placement;
  auto: boolean;
}

interface Job {
  ref: string;
  pin?: string;
  placement: Placement;
  auto: boolean;
  requiredBy?: string;
}

export async function resolveProfile(profile: Profile, deps: ResolveDeps): Promise<ResolveResult> {
  const mc = profile.minecraft;
  const warnings: string[] = [];
  const [javaMajor, fabricLoader, fabricInstaller] = await Promise.all([
    deps.mojang.javaMajor(mc),
    chooseLoader(deps.fabric, mc, profile.loader.fabric),
    deps.fabric.latestStableInstaller(),
  ]);

  const nodes = new Map<string, Node>();
  const incompatible: { from: string; projectId: string }[] = [];
  const queue: Job[] = profile.mods.map((m) => ({
    ref: m.modrinth,
    pin: m.version,
    placement: placementOf(m.side, m.clientOptional),
    auto: false,
  }));

  while (queue.length > 0) {
    const job = queue.shift()!;
    const project = await deps.modrinth.getProject(job.ref);
    if (!project) throw await unknownModError(job, deps.modrinth);
    const placement = job.auto ? clampToProject(job.placement, project) : job.placement;

    const existing = nodes.get(project.id);
    if (existing) {
      existing.auto = existing.auto && job.auto;
      const merged = mergePlacement(existing.placement, placement);
      if (samePlacement(merged, existing.placement)) continue;
      existing.placement = merged;
      queue.push(...(await dependencyJobs(existing, deps.modrinth)));
      continue;
    }

    const version =
      job.auto && job.pin
        ? await deps.modrinth.getVersion(job.pin)
        : pickVersion(await deps.modrinth.getVersions(project.id, mc), job.pin);
    if (!version) throw noBuildError(project, job, mc);
    if (version.version_type !== "release") {
      warnings.push(
        `${project.title}: only a ${version.version_type} build exists for Minecraft ${mc}, using ${version.version_number}.`,
      );
    }

    const node: Node = { project, version, placement, auto: job.auto };
    nodes.set(project.id, node);
    for (const d of version.dependencies) {
      if (d.dependency_type === "incompatible" && d.project_id) incompatible.push({ from: project.title, projectId: d.project_id });
    }
    queue.push(...(await dependencyJobs(node, deps.modrinth)));
  }

  for (const { from, projectId } of incompatible) {
    const other = nodes.get(projectId);
    if (other) {
      throw new UserError(
        `${from} and ${other.project.title} don't work together (${from} says so on Modrinth). Remove one of them from the profile.`,
      );
    }
  }

  const files: LockEntry[] = [...nodes.values()]
    .map((n) => {
      const file = primaryFile(n.version, n.project.title);
      const { side, clientOptional } = sideOf(n.placement);
      return {
        slug: n.project.slug,
        projectId: n.project.id,
        versionId: n.version.id,
        versionNumber: n.version.version_number,
        filename: file.filename,
        url: file.url,
        sha1: file.hashes.sha1,
        sha512: file.hashes.sha512,
        size: file.size,
        side,
        clientOptional,
        auto: n.auto,
        prerelease: n.version.version_type !== "release",
      };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const waiting = await checkWaiting(profile, deps.modrinth);
  warnings.push(...waiting.warnings);

  const lock: Lockfile = {
    lockfileVersion: 1,
    profile: profile.name,
    profileHash: await profileHash(profile),
    minecraft: mc,
    javaMajor,
    fabricLoader,
    fabricInstaller,
    files,
  };
  return { lock, warnings, waiting: waiting.statuses };
}

export async function checkWaiting(
  profile: Profile,
  modrinth: ModrinthClient,
): Promise<{ statuses: WaitingStatus[]; warnings: string[] }> {
  const statuses: WaitingStatus[] = [];
  const warnings: string[] = [];
  for (const slug of profile.waiting) {
    const project = await modrinth.getProject(slug);
    if (!project) {
      warnings.push(`Waiting mod "${slug}" isn't on Modrinth. Check the spelling.`);
      statuses.push({ slug, ready: false });
      continue;
    }
    const ready = pickVersion(await modrinth.getVersions(project.id, profile.minecraft)) !== null;
    statuses.push(ready ? { slug, ready, suggestedSide: sideFromMetadata(project) } : { slug, ready });
  }
  return { statuses, warnings };
}

export async function checkAvailability(
  profile: Profile,
  minecraft: string,
  modrinth: ModrinthClient,
): Promise<{ slug: string; available: boolean; waiting: boolean }[]> {
  const entries = [
    ...profile.mods.map((m) => ({ slug: m.modrinth, waiting: false })),
    ...profile.waiting.map((slug) => ({ slug, waiting: true })),
  ];
  const report = [];
  for (const e of entries) {
    const project = await modrinth.getProject(e.slug);
    const available = project ? pickVersion(await modrinth.getVersions(project.id, minecraft)) !== null : false;
    report.push({ slug: e.slug, available, waiting: e.waiting });
  }
  return report;
}

async function dependencyJobs(node: Node, modrinth: ModrinthClient): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const d of node.version.dependencies) {
    if (d.dependency_type !== "required") continue;
    let projectId = d.project_id;
    if (!projectId && d.version_id) projectId = (await modrinth.getVersion(d.version_id))?.project_id ?? null;
    if (!projectId) {
      const title = node.project.title;
      throw new UserError(
        `${title} needs "${d.file_name ?? "a file"}", which isn't on Modrinth. Upload that jar with /mod add, or drop ${title} from the profile.`,
      );
    }
    jobs.push({
      ref: projectId,
      pin: d.version_id ?? undefined,
      placement: node.placement,
      auto: true,
      requiredBy: node.project.title,
    });
  }
  return jobs;
}

async function unknownModError(job: Job, modrinth: ModrinthClient): Promise<UserError> {
  if (job.auto) {
    return new UserError(
      `${job.requiredBy} needs a Modrinth project (${job.ref}) that no longer exists. Drop ${job.requiredBy} from the profile.`,
    );
  }
  const guess = await modrinth.searchSlug(job.ref);
  const hint = guess && guess !== job.ref ? ` Did you mean "${guess}"?` : "";
  return new UserError(`No mod called "${job.ref}" on Modrinth.${hint}`);
}

function noBuildError(project: MrProject, job: Job, mc: string): UserError {
  if (job.auto) {
    return new UserError(
      `${job.requiredBy} needs ${project.title}, which has no Fabric build for Minecraft ${mc} yet. Move the mod that needs it to "waiting".`,
    );
  }
  if (job.pin) {
    return new UserError(
      `${project.title}: version "${job.pin}" isn't available for Minecraft ${mc} on Fabric. Remove the "version" pin or pick one from https://modrinth.com/mod/${project.slug}/versions.`,
    );
  }
  return new UserError(
    `${project.title} (${project.slug}) has no Fabric build for Minecraft ${mc} yet. Move "${project.slug}" to "waiting" in the profile to skip it for now.`,
  );
}
