import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError, type Fetch } from "@mc/profile";
import { z } from "zod";
import { fetchVerified } from "../download";
import { sha256File } from "../host/snapshot";
import { unzipTo } from "./unzip";
import { javaMajor, requireJava } from "./version";

export interface JavaOptions {
  cacheDir: string;
  fetch: Fetch;
  userAgent: string;
  log: (line: string) => void;
  /** The PC the Java is for. Defaults to this one; tests pick another. */
  platform?: string;
  arch?: string;
}

const OS: Record<string, string> = { linux: "linux", win32: "windows" };
const ARCH: Record<string, string> = { x64: "x64", arm64: "aarch64" };

const Assets = z.array(
  z.object({ binary: z.object({ package: z.object({ name: z.string(), link: z.string(), checksum: z.string(), size: z.number() }) }) }),
);
type Package = z.infer<typeof Assets>[number]["binary"]["package"];

function javaBinIn(dir: string, platform: string): string {
  return join(dir, "bin", platform === "win32" ? "java.exe" : "java");
}

/** The Java to run a server with: MC_JAVA if set (and new enough), otherwise the managed JRE. */
export async function javaFor(need: { minecraft: string; javaMajor: number }, o: JavaOptions & { override?: string }): Promise<string> {
  if (o.override) {
    requireJava(need, o.override);
    return o.override;
  }
  return ensureJava(need.javaMajor, o);
}

/** Path to a Temurin JRE for this Java major, downloading it into the cache the first time. */
export async function ensureJava(major: number, o: JavaOptions): Promise<string> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const root = join(o.cacheDir, "java");
  const dir = join(root, String(major));
  const bin = javaBinIn(dir, platform);
  if (existsSync(join(dir, ".complete"))) {
    if (javaMajor(bin) === major) return bin;
    o.log(`The Java ${major} in ${dir} doesn't run anymore, so it's downloaded again.`);
  }
  await rm(dir, { recursive: true, force: true });

  const os = OS[platform];
  const cpu = ARCH[arch];
  if (!os || !cpu) throw noBuild(major, platform, arch);
  const pkg = await latestPackage(major, os, cpu, o);
  o.log(`Downloading Java ${major} (${Math.round(pkg.size / 1_048_576)} MB)…`);
  const archive = await download(major, pkg, o);

  const tmp = join(root, `${major}.tmp`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    await extract(archive, pkg.name, tmp);
    const top = await readdir(tmp);
    const home = top.length === 1 && (await stat(join(tmp, top[0]!))).isDirectory() ? join(tmp, top[0]!) : tmp;
    const found = javaMajor(javaBinIn(home, platform));
    if (found !== major) {
      throw new UserError(`The Java ${major} download didn't work (its java reports ${found ?? "nothing"}). Run the command again.`);
    }
    await rename(home, dir);
    await writeFile(join(dir, ".complete"), `${pkg.name}\n`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return bin;
}

function noBuild(major: number, os: string, arch: string): UserError {
  return new UserError(`There's no Java ${major} download for ${os}/${arch}. Set MC_JAVA to a Java ${major} install to use this PC.`);
}

async function latestPackage(major: number, os: string, arch: string, o: JavaOptions): Promise<Package> {
  const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=${os}&architecture=${arch}&image_type=jre&vendor=eclipse`;
  const failed = (why: string) => new UserError(`Couldn't download Java ${major} for this PC (${why}). Check your internet and try again.`);
  let res: Response;
  try {
    res = await o.fetch(url, { headers: { "User-Agent": o.userAgent } });
  } catch (err) {
    throw failed((err as Error).message);
  }
  if (!res.ok) throw failed(`Adoptium answered HTTP ${res.status}`);
  const parsed = Assets.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw failed("Adoptium sent an answer mc-host doesn't understand");
  const first = parsed.data[0];
  if (!first) throw noBuild(major, os, arch);
  return first.binary.package;
}

/** Download into the URL-keyed file cache and check Adoptium's SHA-256; one retry. */
async function download(major: number, pkg: Package, o: JavaOptions): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const path = await fetchVerified(pkg.link, undefined, o);
    if ((await sha256File(path)) === pkg.checksum.toLowerCase()) return path;
    await rm(path, { force: true });
  }
  throw new UserError(`Java ${major} was corrupted twice while downloading (its checksum didn't match). Try again later.`);
}

async function extract(archive: string, name: string, dest: string): Promise<void> {
  if (name.endsWith(".zip")) {
    await unzipTo(archive, dest);
    // Zips carry no Unix permissions. Only matters when a Windows JRE is unpacked on Linux (tests).
    if (process.platform !== "win32") await markExecutable(dest);
    return;
  }
  let p;
  try {
    p = Bun.spawnSync(["tar", "-xzf", archive, "-C", dest]);
  } catch {
    throw new UserError(`Couldn't unpack ${name}: tar isn't installed.`);
  }
  if (p.exitCode !== 0) throw new UserError(`Couldn't unpack ${name} (${p.stderr.toString().trim() || `tar exited with ${p.exitCode}`}).`);
}

async function markExecutable(dest: string): Promise<void> {
  const tops = await readdir(dest);
  for (const binDir of [join(dest, "bin"), ...tops.map((t) => join(dest, t, "bin"))]) {
    if (!existsSync(binDir)) continue;
    for (const f of await readdir(binDir)) await chmod(join(binDir, f), 0o755);
  }
}
