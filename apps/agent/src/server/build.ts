import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serverLauncherUrl, UserError, type Fetch, type Lockfile, type Profile } from "@mc/profile";
import { fetchVerified, sourceFor, type JarSource } from "../download";
import { matchPacks } from "./packs";
import { mergeProperties } from "./properties";

export const LAUNCHER_JAR = "fabric-server-launch.jar";
export const MARKER = ".mc-host.json";

export interface ServerMarker {
  profile: string;
  minecraft: string;
  javaMajor: number;
  memory: { min: string; max: string };
  /** False while a build is in progress; `run` refuses a folder whose last build didn't finish. */
  complete: boolean;
}

export interface BuildServerOptions {
  profile: Profile;
  lock: Lockfile;
  dir: string;
  packsDir?: string;
  /** Build even if the folder holds another profile's world or jars mc-host didn't put there. */
  force?: boolean;
  fetch: Fetch;
  cacheDir: string;
  userAgent: string;
  log?: (line: string) => void;
  /** Needed when the lockfile has uploaded jars. */
  jarSource?: JarSource;
}

export async function buildServer(o: BuildServerOptions): Promise<{ mods: string[]; removed: string[]; datapacks: string[] }> {
  const log = o.log ?? (() => {});
  const dl = { fetch: o.fetch, cacheDir: o.cacheDir, userAgent: o.userAgent };
  const wanted = o.lock.files.filter((f) => f.side !== "client-optional");
  for (const f of wanted) {
    if (!/^[^/\\]+\.jar$/.test(f.filename) || f.filename.startsWith(".")) {
      throw new UserError(`Unsafe file name in the lockfile: "${f.filename}". Run "mc-host profile resolve" again.`);
    }
  }
  const sources = wanted.map((f) => sourceFor(f, o.fetch, o.jarSource));

  // Everything that can fail without touching the folder happens first: the folder guard,
  // the datapack check and every download. A dropped connection leaves the old server intact.
  await guardFolder(o);
  const packs = await planDatapacks(o);
  const launcher = await fetchVerified(serverLauncherUrl(o.lock.minecraft, o.lock.fabricLoader, o.lock.fabricInstaller), undefined, dl);
  const jars: [string, string][] = [];
  for (const [i, f] of wanted.entries()) {
    const s = sources[i]!;
    jars.push([await fetchVerified(s.url, f.sha512, { ...dl, fetch: s.fetch }), f.filename]);
  }

  const marker: ServerMarker = {
    profile: o.profile.name,
    minecraft: o.lock.minecraft,
    javaMajor: o.lock.javaMajor,
    memory: o.profile.memory,
    complete: false,
  };
  const removed = await writing(o.dir, async () => {
    await mkdir(join(o.dir, "mods"), { recursive: true });
    await writeMarker(o.dir, marker);
    await copyFile(launcher, join(o.dir, LAUNCHER_JAR));
    for (const [cached, filename] of jars) await copyFile(cached, join(o.dir, "mods", filename));
    const keep = new Set(wanted.map((f) => f.filename));
    const stale = (await readdir(join(o.dir, "mods"))).filter((n) => n.endsWith(".jar") && !keep.has(n)).sort();
    for (const n of stale) await rm(join(o.dir, "mods", n));

    const propsPath = join(o.dir, "server.properties");
    const existing = existsSync(propsPath) ? await readFile(propsPath, "utf8") : "";
    await writeFile(propsPath, mergeProperties(existing, o.profile.properties));

    if (packs) {
      await mkdir(packs.target, { recursive: true });
      for (const file of packs.files) await copyFile(join(o.packsDir!, file), join(packs.target, file));
    }
    await writeMarker(o.dir, { ...marker, complete: true });
    return stale;
  });

  log(`Fabric ${o.lock.fabricLoader} launcher for Minecraft ${o.lock.minecraft}`);
  log(`${wanted.length} mods installed${removed.length ? `, removed ${removed.join(", ")}` : ""}`);
  if (packs) log(`${packs.files.length} datapacks copied into ${packs.target}`);
  return { mods: wanted.map((f) => f.filename).sort(), removed, datapacks: packs?.files ?? [] };
}

/** Refuse to overwrite another profile's server, or jars mc-host didn't put there. */
async function guardFolder(o: BuildServerOptions): Promise<void> {
  if (o.force) return;
  if (existsSync(join(o.dir, MARKER))) {
    const m = await readMarker(o.dir);
    if (m.profile !== o.profile.name || m.minecraft !== o.lock.minecraft) {
      throw new UserError(
        `${o.dir} holds the "${m.profile}" world (Minecraft ${m.minecraft}). Building "${o.profile.name}" ` +
          `(Minecraft ${o.lock.minecraft}) there would replace its mods and can break that world. ` +
          `Pick another folder, or add --force if you really mean it.`,
      );
    }
    return;
  }
  const modsDir = join(o.dir, "mods");
  if (existsSync(modsDir) && (await readdir(modsDir)).some((n) => n.endsWith(".jar"))) {
    throw new UserError(`${modsDir} already has jars that mc-host didn't put there. Pick an empty folder, or add --force to replace them.`);
  }
}

async function planDatapacks(o: BuildServerOptions): Promise<{ target: string; files: string[] } | null> {
  if (o.profile.datapacks.length === 0) return null;
  const levelName = String(o.profile.properties["level-name"] ?? "world");
  if (existsSync(join(o.dir, levelName))) {
    o.log?.(`${levelName}/ already exists, so its datapacks are left alone`);
    return null;
  }
  if (!o.packsDir) {
    throw new UserError(
      `This profile needs ${o.profile.datapacks.length} datapacks. Run again with --packs <folder> pointing at the folder with the zips.`,
    );
  }
  if (!existsSync(o.packsDir)) throw new UserError(`The --packs folder ${o.packsDir} doesn't exist. Check the path and try again.`);
  const { found, missing } = matchPacks(o.profile.datapacks, await readdir(o.packsDir));
  if (missing.length) {
    throw new UserError(`These datapacks aren't in ${o.packsDir}: ${missing.join(", ")}. Add their zips, or remove them from the profile.`);
  }
  return { target: join(o.dir, levelName, "datapacks"), files: [...found.values()] };
}

/** Turn "file in use" and permission errors into advice; on Windows a running server locks its jars. */
async function writing<T>(dir: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new UserError(`Couldn't write to ${dir} (${code}). Stop the server if it's running, then try again.`);
    }
    throw err;
  }
}

async function writeMarker(dir: string, marker: ServerMarker): Promise<void> {
  await writeFile(join(dir, MARKER), JSON.stringify(marker, null, 2) + "\n");
}

export async function readMarker(dir: string): Promise<ServerMarker> {
  const path = join(dir, MARKER);
  if (!existsSync(path)) {
    throw new UserError(`${dir} isn't a server folder built by mc-host. Run "mc-host profile build-server <profile> ${dir}" first.`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as ServerMarker;
  } catch {
    throw new UserError(`${path} is damaged. Run "mc-host profile build-server" for this folder again (add --force).`);
  }
}
