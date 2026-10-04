import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildMrpack,
  checkAvailability,
  checkWaiting,
  createFabricMeta,
  createModrinthClient,
  createMojangMeta,
  isJarEntry,
  isUploadedJar,
  isVanillaCompatible,
  parseLock,
  parseProfile,
  profileHash,
  resolveProfile,
  serializeLock,
  USER_AGENT,
  UserError,
  type ExtraFile,
  type Fetch,
  type JarLookup,
  type Lockfile,
  type Profile,
  type ResolveDeps,
} from "@mc/profile";
import { runAdmin } from "./admin";
import type { Command } from "./cli";
import { fetchVerified, sourceFor, type JarSource } from "./download";
import { createAdminApi } from "./host/api";
import { cmdStart, cmdStatus, cmdStop } from "./host/commands";
import { loadAdminConfig, loadHostConfig } from "./host/config";
import { crashSummary } from "./run/crash";
import { ensureEula } from "./run/eula";
import { javaFor } from "./java/runtime";
import { cmdLobby } from "./lobby/command";
import { cmdCheckPacks } from "./packs/command";
import { runServer } from "./run/server";
import { buildServer, readMarker } from "./server/build";
import { VERSION } from "./version";

export interface Deps {
  fetch: Fetch;
  cacheDir: string;
  configDir: string;
  log: (line: string) => void;
  ask: (question: string) => Promise<string>;
  /** Override the API clients (tests). Defaults to the live Modrinth, Fabric and Mojang APIs. */
  clients?: ResolveDeps;
  /** MC_JAVA: run servers with this java instead of the managed one. */
  javaBin?: string;
  now?: () => number;
  /** Environment for MC_WORKER_URL / MC_TOKEN / MC_ADMIN_SECRET. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Where hosted worlds and local state live. Defaults to paths.dataDir(). */
  dataDir?: string;
}

export function clientsFor(deps: Deps): ResolveDeps {
  if (deps.clients) return deps.clients;
  const http = { fetch: deps.fetch, userAgent: USER_AGENT };
  return { modrinth: createModrinthClient(http), fabric: createFabricMeta(http), mojang: createMojangMeta(http) };
}

export async function loadProfile(
  profilesDir: string,
  name: string,
): Promise<{ profile: Profile; path: string; raw: Record<string, unknown> }> {
  const path = join(profilesDir, `${name}.json`);
  if (!existsSync(path)) {
    const names = existsSync(profilesDir)
      ? (await readdir(profilesDir)).filter((f) => f.endsWith(".json") && !f.endsWith(".lock.json")).map((f) => f.slice(0, -5))
      : [];
    throw new UserError(`No profile called "${name}". Available: ${names.join(", ") || `none in ${profilesDir}/`}.`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new UserError(`${name}.json isn't valid JSON: ${(err as Error).message}`);
  }
  return { profile: parseProfile(raw, `${name}.json`), path, raw };
}

export async function loadLock(profilesDir: string, name: string, profile: Profile): Promise<Lockfile> {
  const path = join(profilesDir, `${name}.lock.json`);
  if (!existsSync(path)) throw new UserError(`${name} has no lockfile yet. Run "mc-host profile resolve ${name}" first.`);
  const lock = parseLock(await readFile(path, "utf8"), `${name}.lock.json`);
  if (lock.profileHash !== (await profileHash(profile))) {
    throw new UserError(`${name}.json changed since its lockfile was made. Run "mc-host profile resolve ${name}" first.`);
  }
  return lock;
}

async function cmdResolve(cmd: Extract<Command, { kind: "resolve" }>, deps: Deps): Promise<void> {
  const clients = clientsFor(deps);
  let { profile, path, raw } = await loadProfile(cmd.profilesDir, cmd.name);

  if (cmd.check) {
    const report = await checkAvailability(profile, cmd.check, clients.modrinth);
    for (const r of report) {
      deps.log(`${r.slug}: ${r.available ? "available" : "missing"}${r.waiting ? " (waiting)" : ""}`);
    }
    const ok = report.filter((r) => r.available).length;
    deps.log(`${ok} of ${report.length} mods have a Fabric build for Minecraft ${cmd.check}.`);
    return;
  }

  if (cmd.addReady) {
    const { statuses } = await checkWaiting(profile, clients.modrinth);
    const ready = statuses.filter((s) => s.ready);
    const readySlugs = new Set(ready.map((s) => s.slug));
    raw = {
      ...raw,
      mods: [...(raw.mods as unknown[]), ...ready.map((s) => ({ modrinth: s.slug, side: s.suggestedSide }))],
      waiting: ((raw.waiting as string[] | undefined) ?? []).filter((s) => !readySlugs.has(s)),
    };
    await writeFile(path, JSON.stringify(raw, null, 2) + "\n");
    profile = parseProfile(raw, `${cmd.name}.json`);
    deps.log(ready.length ? `Moved ${[...readySlugs].join(", ")} from waiting into mods.` : "No waiting mods are ready yet.");
  }

  const jars = clients.jars ?? (profile.mods.some(isJarEntry) ? await adminJars(deps) : undefined);
  const { lock, warnings, waiting } = await resolveProfile(profile, { ...clients, jars });
  await writeFile(join(cmd.profilesDir, `${cmd.name}.lock.json`), serializeLock(lock));
  const auto = lock.files.filter((f) => f.auto).length;
  deps.log(
    `Resolved ${cmd.name}: Minecraft ${lock.minecraft}, Fabric ${lock.fabricLoader}, Java ${lock.javaMajor}, ` +
      `${lock.files.length} files (${auto} pulled in as dependencies).`,
  );
  for (const w of warnings) deps.log(`warning: ${w}`);
  const ready = waiting.filter((w) => w.ready).map((w) => w.slug);
  const still = waiting.filter((w) => !w.ready).map((w) => w.slug);
  if (ready.length) deps.log(`Now available: ${ready.join(", ")}. Run "mc-host profile resolve ${cmd.name} --add-ready" to add them.`);
  if (still.length) deps.log(`Still waiting: ${still.join(", ")}.`);
}

async function cmdBuildServer(cmd: Extract<Command, { kind: "build-server" }>, deps: Deps): Promise<void> {
  const { profile } = await loadProfile(cmd.profilesDir, cmd.name);
  const lock = await loadLock(cmd.profilesDir, cmd.name, profile);
  await buildServer({
    profile,
    lock,
    dir: cmd.dir,
    packsDir: cmd.packsDir,
    force: cmd.force,
    fetch: deps.fetch,
    cacheDir: deps.cacheDir,
    userAgent: USER_AGENT,
    log: deps.log,
    jarSource: await localJarSource(deps, lock),
  });
  deps.log(`Server ready in ${cmd.dir}. Start it with: mc-host profile run ${cmd.dir}`);
}

async function cmdBuildMrpack(cmd: Extract<Command, { kind: "build-mrpack" }>, deps: Deps): Promise<void> {
  const { profile } = await loadProfile(cmd.profilesDir, cmd.name);
  const lock = await loadLock(cmd.profilesDir, cmd.name, profile);
  const source = await localJarSource(deps, lock);
  const extras: ExtraFile[] = [];
  for (const f of lock.files.filter((f) => isUploadedJar(f) && f.side !== "server")) {
    const s = sourceFor(f, deps.fetch, source);
    const path = await fetchVerified(s.url, f.sha512, { fetch: s.fetch, cacheDir: deps.cacheDir, userAgent: USER_AGENT, label: s.label, hint: s.hint });
    extras.push({ path: `mods/${f.filename}`, data: new Uint8Array(await readFile(path)) });
  }
  const bytes = await buildMrpack(lock, { name: `${profile.name} (Minecraft ${lock.minecraft})`, summary: profile.description }, extras);
  await writeFile(cmd.out, bytes);
  deps.log(`Wrote ${cmd.out}. Import it in Prism Launcher: Add Instance → Import.`);
  deps.log(
    isVanillaCompatible(lock)
      ? "Vanilla clients can join this world; the modpack is optional."
      : "Players need this modpack to join this world.",
  );
}

async function cmdRun(cmd: Extract<Command, { kind: "run" }>, deps: Deps): Promise<void> {
  const marker = await readMarker(cmd.dir);
  if (!marker.complete) {
    throw new UserError(`The last build of "${marker.profile}" in ${cmd.dir} didn't finish. Run "mc-host profile build-server ${marker.profile} ${cmd.dir}" again.`);
  }
  const agreed = await ensureEula({ configDir: deps.configDir, serverDir: cmd.dir, ask: deps.ask, log: deps.log });
  if (!agreed) throw new UserError("You need to agree to the EULA to run a server.");
  const javaBin = await javaFor(marker, { cacheDir: deps.cacheDir, fetch: deps.fetch, userAgent: USER_AGENT, log: deps.log, override: deps.javaBin });
  const started = (deps.now ?? Date.now)();
  const code = await runServer({ dir: cmd.dir, marker, javaBin });
  // 129/130/143: stopped by a closed window, Ctrl+C or a terminate signal, which is a normal stop.
  if (code !== 0 && code !== 129 && code !== 130 && code !== 143) {
    deps.log(await crashSummary(cmd.dir, started));
    throw new UserError(`The server stopped with exit code ${code}.`);
  }
}

export async function runCommand(cmd: Command, deps: Deps): Promise<void> {
  switch (cmd.kind) {
    case "help":
      return;
    case "version":
      deps.log(`mc-host ${VERSION}`);
      return;
    case "resolve":
      return cmdResolve(cmd, deps);
    case "build-server":
      return cmdBuildServer(cmd, deps);
    case "build-mrpack":
      return cmdBuildMrpack(cmd, deps);
    case "check-packs":
      return cmdCheckPacks(cmd, deps);
    case "run":
      return cmdRun(cmd, deps);
    case "lobby":
      return cmdLobby(cmd, deps);
    case "start":
      return cmdStart(deps);
    case "stop":
      return cmdStop(deps);
    case "status":
      return cmdStatus(deps);
    case "admin-world-create":
    case "admin-token-mint":
    case "admin-lease-release":
    case "admin-status":
    case "admin-jar-add":
    case "admin-lobby-token":
    case "admin-lobby-release":
      return runAdmin(cmd, deps);
  }
}

/** Uploaded jars are looked up on the Worker with the admin secret. */
async function adminJars(deps: Deps): Promise<JarLookup> {
  const api = createAdminApi({ ...(await loadAdminConfig(deps.env ?? process.env, deps.configDir)), fetch: deps.fetch });
  return { lookup: (sha512) => api.getJar(sha512) };
}

export async function localJarSource(deps: Deps, lock: Lockfile): Promise<JarSource | undefined> {
  if (!lock.files.some(isUploadedJar)) return undefined;
  const env = deps.env ?? process.env;
  for (const load of [
    async () => {
      const a = await loadAdminConfig(env, deps.configDir);
      return { workerUrl: a.workerUrl, secret: a.secret };
    },
    async () => {
      const h = await loadHostConfig(env, deps.configDir);
      return { workerUrl: h.workerUrl, secret: h.token };
    },
  ]) {
    try {
      return await load();
    } catch {}
  }
  throw new UserError(`${lock.profile} has uploaded jars, which come from the Worker. Set MC_WORKER_URL and MC_ADMIN_SECRET (or MC_TOKEN).`);
}
