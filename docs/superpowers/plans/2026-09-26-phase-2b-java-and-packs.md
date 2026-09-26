# Phase 2b: Managed Java and datapack checks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every host runs Minecraft on a Temurin JRE that mc-host downloads itself, and the maintainer gets `mc-host profile check-packs`, which boots a throwaway server and names the datapacks that break it.

**Architecture:** `apps/agent/src/java/` downloads, verifies and caches a JRE per Java major from the Adoptium API. The hosting session, `profile run` and `check-packs` resolve Java through one function, `javaFor`, which honours an `MC_JAVA` override. `apps/agent/src/packs/` has four parts: a zip indexer, a pure log scanner (errors, baseline filtering, blaming packs), a boot loop that is independent of Java, and a real boot that drives the Fabric server in a scratch folder.

**Tech Stack:** Bun + TypeScript, `bun:test`, fflate (inflate only; its streaming deflate is broken, see `host/snapshot.ts`), zod 4, system `tar` for `.tar.gz`, Docker (`debian:stable-slim`).

**Spec:** [docs/superpowers/specs/2026-09-26-phase-2b-java-and-packs-design.md](../specs/2026-09-26-phase-2b-java-and-packs-design.md)

## Global Constraints

- Adoptium query: `https://api.adoptium.net/v3/assets/latest/<major>/hotspot?os=<os>&architecture=<arch>&image_type=jre&vendor=eclipse`; use `[0].binary.package` → `{ name, link, checksum, size }`; `checksum` is SHA-256 hex.
- Platforms: `linux`/`win32` → `linux`/`windows`; `x64`/`arm64` → `x64`/`aarch64`. Anything else is a `UserError`.
- Cache layout: `<cacheDir>/java/<major>/` (final), `<cacheDir>/java/<major>.tmp/` (extracting), `<cacheDir>/java/<major>/.complete` (marker).
- The Java version comes from `lock.javaMajor` / `marker.javaMajor`. Nothing else chooses it.
- `MC_JAVA=<path>` overrides the managed JRE everywhere and is checked with `requireJava`.
- Java is resolved **before** the lease is claimed, and after the EULA prompt.
- Scratch server for pack checks: `<cacheDir>/check-packs/<profile>/`, world `check`, `level-type=minecraft:flat`, logs in `check-logs/<NN>-<label>.log`. Server files persist; the world and logs are deleted unless `--keep`.
- Boot timeouts: 3 minutes to reach `Done (`, then 1 minute to exit after `stop`; otherwise kill.
- `minecraft:` ids never count as a pack *mentioning* an id (they can still count as *providing* one).
- Report: at most 3 evidence lines per pack, each cut to 300 characters; exit code 1 if anything failed.
- User-facing errors are `UserError`s in plain English, the same style as the existing ones.
- Test zips are built with `zipSync(..., { level: 0 })`: stored, never fflate-deflated.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5
  ```

## Review Focus

1. **Mod errors whose text changes between boots** (timings, counts) would get past the baseline and make every pack look broken. Numbers are normalised in `errorKey`; Task 4 tests it.
2. **Pack file names with spaces and parentheses** (every Vanilla Tweaks zip) must survive copying, `file/<name>.zip` matching and log file names. Tasks 4, 6 and 7 use real VT names.
3. **A server that hangs**, either before `Done (` or after `stop`, must be killed and reported, not wait forever. Task 6 tests both.
4. **An interrupted JRE download or extraction** must never leave a JRE that looks usable. Task 1 tests a stale `.tmp`, a bad checksum and a wrong version.
5. **`MC_JAVA` pointing at a too-old Java** must fail with the plain-English message, without downloading anything. Tasks 1 and 2 test it.

---

## File Structure

```
apps/agent/src/java/
  version.ts      MOVED from run/java.ts: parseJavaMajor, javaMajor, requireJava
  unzip.ts        NEW  unzipTo(zip, dest), refusing entries that escape dest
  runtime.ts      NEW  ensureJava(major, o), javaFor(need, o)
apps/agent/src/packs/
  index.ts        NEW  indexPack, provides, mentions
  logscan.ts      NEW  scanLog, errorKey, resourceIds, packFileMentions, attribute
  check.ts        NEW  checkPacks (boot loop), formatReport, Boot/BootResult types
  boot.ts         NEW  createBoot: the real boot with timeouts and log files
  command.ts      NEW  cmdCheckPacks
apps/agent/src/host/console.ts   ServerProcess.kill, spawnProcess stderr option, exited waits for stdout
apps/agent/src/host/deps.ts      checkJava → ensureJava; launch gets javaBin
apps/agent/src/host/prepare.ts   ensureJava before claim; Prepared.javaBin
apps/agent/src/host/run.ts       launch with p.javaBin
apps/agent/src/host/commands.ts  wire javaFor
apps/agent/src/commands.ts       profile run via javaFor (EULA first); check-packs case
apps/agent/src/cli.ts            MC_JAVA; check-packs parsing and usage
infra/docker/Dockerfile          debian:stable-slim, no Java
apps/agent/test/fixtures/packs/  baseline.log, fatal.log, clean.log (real 26.3 boots)
```

---

### Task 1: Managed JRE download

**Files:**
- Move: `apps/agent/src/run/java.ts` → `apps/agent/src/java/version.ts` (content unchanged)
- Modify: `apps/agent/src/commands.ts:29`, `apps/agent/src/host/commands.ts:7`, `apps/agent/test/run.test.ts:8` (import paths)
- Create: `apps/agent/src/java/unzip.ts`, `apps/agent/src/java/runtime.ts`
- Test: `apps/agent/test/java-runtime.test.ts`

**Interfaces:**
- Consumes: `fetchVerified(url, undefined, { fetch, cacheDir, userAgent })` from `src/download.ts` (caches by URL when no sha512 is given); `sha256File(path)` from `src/host/snapshot.ts`; `sha256Hex` from `@mc/profile`.
- Produces:
  - `interface JavaOptions { cacheDir: string; fetch: Fetch; userAgent: string; log: (line: string) => void; platform?: string; arch?: string }`
  - `ensureJava(major: number, o: JavaOptions): Promise<string>`: absolute path to `bin/java` or `bin/java.exe`
  - `javaFor(need: { minecraft: string; javaMajor: number }, o: JavaOptions & { override?: string }): Promise<string>`
  - `unzipTo(zipFile: string, dest: string): Promise<void>`
  - `parseJavaMajor`, `javaMajor`, `requireJava` now live in `src/java/version.ts`

- [ ] **Step 1: Move the version helpers**

```bash
mkdir -p apps/agent/src/java
git mv apps/agent/src/run/java.ts apps/agent/src/java/version.ts
sed -i 's#from "./run/java"#from "./java/version"#' apps/agent/src/commands.ts
sed -i 's#from "../run/java"#from "../java/version"#' apps/agent/src/host/commands.ts
sed -i 's#from "../src/run/java"#from "../src/java/version"#' apps/agent/test/run.test.ts
bun test apps/agent && bun run typecheck
```
Expected: all tests pass, and the typecheck is clean.

- [ ] **Step 2: Write the failing tests**

Create `apps/agent/test/java-runtime.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { sha256Hex, type Fetch } from "@mc/profile";
import { ensureJava, javaFor } from "../src/java/runtime";
import { unzipTo } from "../src/java/unzip";

let root: string;
let cache: string;
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-java-"));
  cache = join(root, "cache");
});

/** A shell script that answers `-version` like Java does, on stderr. */
const stub = (version: string) => `#!/bin/sh\necho 'openjdk version "${version}" 2026-07-21' >&2\n`;

function stubFile(version: string): string {
  const path = join(root, `java-${version}`);
  writeFileSync(path, stub(version));
  chmodSync(path, 0o755);
  return path;
}

/** jdk-<v>-jre/bin/java in a .tar.gz, the shape Adoptium ships for Linux. */
function tarGz(version: string): Uint8Array {
  const src = join(root, `src-${version}`);
  const exe = join(src, `jdk-${version}-jre`, "bin", "java");
  mkdirSync(join(src, `jdk-${version}-jre`, "bin"), { recursive: true });
  writeFileSync(exe, stub(version));
  chmodSync(exe, 0o755);
  const out = join(root, `jre-${version}.tar.gz`);
  const p = Bun.spawnSync(["tar", "-czf", out, "-C", src, `jdk-${version}-jre`]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return new Uint8Array(readFileSync(out));
}

/** jdk-<v>-jre/bin/java.exe in a .zip, the shape Adoptium ships for Windows. */
const zip = (version: string) => zipSync({ [`jdk-${version}-jre/bin/java.exe`]: enc(stub(version)) }, { level: 0 });

function adoptium(o: { name: string; archive: Uint8Array; bodies?: Uint8Array[]; assets?: unknown; status?: number }) {
  const calls: string[] = [];
  let downloads = 0;
  const fetch: Fetch = async (url) => {
    calls.push(url);
    if (url.startsWith("https://api.adoptium.net/")) {
      if (o.status) return new Response("unavailable", { status: o.status });
      const pkg = { name: o.name, link: `https://github.test/${o.name}`, checksum: await sha256Hex(o.archive), size: o.archive.length };
      return Response.json(o.assets ?? [{ binary: { package: pkg } }]);
    }
    const bodies = o.bodies ?? [o.archive];
    return new Response(bodies[Math.min(downloads++, bodies.length - 1)]);
  };
  return { fetch, calls, downloads: () => downloads };
}

const opts = (fetch: Fetch, platform = "linux", arch = "x64") => ({ cacheDir: cache, fetch, userAgent: "ua", log: () => {}, platform, arch });
const LINUX = "OpenJDK25U-jre_x64_linux_hotspot_25.0.4.1_1.tar.gz";

test("downloads, verifies and unpacks a Linux JRE, then reuses it without the network", async () => {
  const a = adoptium({ name: LINUX, archive: tarGz("25.0.4") });
  const bin = await ensureJava(25, opts(a.fetch));
  expect(bin).toBe(join(cache, "java", "25", "bin", "java"));
  expect(a.calls[0]).toBe("https://api.adoptium.net/v3/assets/latest/25/hotspot?os=linux&architecture=x64&image_type=jre&vendor=eclipse");
  expect(readFileSync(join(cache, "java", "25", ".complete"), "utf8")).toBe(`${LINUX}\n`);
  expect(existsSync(join(cache, "java", "25.tmp"))).toBe(false);
  const before = a.calls.length;
  expect(await ensureJava(25, opts(a.fetch))).toBe(bin);
  expect(a.calls.length).toBe(before);
});

test("unpacks a Windows zip and asks Adoptium for windows/aarch64", async () => {
  const a = adoptium({ name: "OpenJDK25U-jre_aarch64_windows_hotspot_25.0.4.1_1.zip", archive: zip("25.0.4") });
  const bin = await ensureJava(25, opts(a.fetch, "win32", "arm64"));
  expect(bin).toBe(join(cache, "java", "25", "bin", "java.exe"));
  expect(a.calls[0]).toContain("os=windows&architecture=aarch64");
});

test("a checksum mismatch is downloaded again once", async () => {
  const archive = tarGz("25.0.4");
  const a = adoptium({ name: LINUX, archive, bodies: [enc("garbage"), archive] });
  await ensureJava(25, opts(a.fetch));
  expect(a.downloads()).toBe(2);
});

test("two checksum mismatches fail and leave no JRE behind", async () => {
  const a = adoptium({ name: LINUX, archive: tarGz("25.0.4"), bodies: [enc("garbage")] });
  await expect(ensureJava(25, opts(a.fetch))).rejects.toThrow("Java 25 was corrupted twice while downloading");
  expect(existsSync(join(cache, "java", "25"))).toBe(false);
});

// Review focus 4
test("a leftover .tmp folder from an interrupted run is cleaned up", async () => {
  mkdirSync(join(cache, "java", "25.tmp", "half"), { recursive: true });
  const a = adoptium({ name: LINUX, archive: tarGz("25.0.4") });
  await ensureJava(25, opts(a.fetch));
  expect(existsSync(join(cache, "java", "25.tmp"))).toBe(false);
});

// Review focus 4
test("a cached JRE that reports another version is downloaded again", async () => {
  const dir = join(cache, "java", "25");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "java"), stub("21.0.1"));
  chmodSync(join(dir, "bin", "java"), 0o755);
  writeFileSync(join(dir, ".complete"), "old\n");
  const a = adoptium({ name: LINUX, archive: tarGz("25.0.4") });
  await ensureJava(25, opts(a.fetch));
  expect(a.downloads()).toBe(1);
  expect(readFileSync(join(dir, ".complete"), "utf8")).toBe(`${LINUX}\n`);
});

test("a download whose java reports the wrong version is refused", async () => {
  const a = adoptium({ name: LINUX, archive: tarGz("21.0.1") });
  await expect(ensureJava(25, opts(a.fetch))).rejects.toThrow("The Java 25 download didn't work (its java reports 21)");
  expect(existsSync(join(cache, "java", "25"))).toBe(false);
  expect(existsSync(join(cache, "java", "25.tmp"))).toBe(false);
});

test("no build for this platform says how to use your own Java", async () => {
  const a = adoptium({ name: LINUX, archive: tarGz("25.0.4"), assets: [] });
  await expect(ensureJava(25, opts(a.fetch))).rejects.toThrow("There's no Java 25 download for linux/x64. Set MC_JAVA");
  const b = adoptium({ name: LINUX, archive: tarGz("25.0.4") });
  await expect(ensureJava(25, opts(b.fetch, "darwin"))).rejects.toThrow("There's no Java 25 download for darwin/x64");
  expect(b.calls).toEqual([]);
});

test("Adoptium errors are plain English", async () => {
  const a = adoptium({ name: LINUX, archive: enc(""), status: 503 });
  await expect(ensureJava(25, opts(a.fetch))).rejects.toThrow("Couldn't download Java 25 for this PC (Adoptium answered HTTP 503)");
});

// Review focus 5
test("javaFor uses MC_JAVA when it's new enough, and refuses it plainly when it isn't", async () => {
  const a = adoptium({ name: LINUX, archive: enc("") });
  const mine = stubFile("25.0.4");
  expect(await javaFor({ minecraft: "26.3", javaMajor: 25 }, { ...opts(a.fetch), override: mine })).toBe(mine);
  const old = stubFile("21.0.1");
  await expect(javaFor({ minecraft: "26.3", javaMajor: 25 }, { ...opts(a.fetch), override: old })).rejects.toThrow(
    "Minecraft 26.3 needs Java 25, but this PC has Java 21",
  );
  expect(a.calls).toEqual([]);
});

test("javaFor downloads when there's no override", async () => {
  const a = adoptium({ name: LINUX, archive: tarGz("25.0.4") });
  expect(await javaFor({ minecraft: "26.3", javaMajor: 25 }, opts(a.fetch))).toBe(join(cache, "java", "25", "bin", "java"));
});

test("unzipTo refuses entries that would land outside the folder", async () => {
  const file = join(root, "evil.zip");
  writeFileSync(file, zipSync({ "../evil.txt": enc("x") }, { level: 0 }));
  await expect(unzipTo(file, join(root, "out"))).rejects.toThrow("unsafe entry: ../evil.txt");
  expect(existsSync(join(root, "evil.txt"))).toBe(false);
});
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/java-runtime.test.ts`
Expected: FAIL with `Cannot find module '../src/java/runtime'`.

- [ ] **Step 4: Write `unzip.ts`**

Create `apps/agent/src/java/unzip.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { UserError } from "@mc/profile";
import { Unzip, UnzipInflate } from "fflate";

/** Unpack a zip into dest. An entry that would land outside dest fails the whole unpack. */
export async function unzipTo(zipFile: string, dest: string): Promise<void> {
  const writes: Promise<unknown>[] = [];
  let failed: unknown = null;
  const unzip = new Unzip((file) => {
    const rel = normalize(file.name);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || /^[a-zA-Z]:/.test(file.name)) {
      failed = new UserError(`${zipFile} has an unsafe entry: ${file.name}`);
      return;
    }
    if (file.name.endsWith("/")) {
      writes.push(mkdir(join(dest, rel), { recursive: true }));
      return;
    }
    const out = join(dest, rel);
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) {
        failed = err;
        return;
      }
      chunks.push(chunk);
      if (final) writes.push(mkdir(dirname(out), { recursive: true }).then(() => Bun.write(out, new Blob(chunks))));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for await (const chunk of Bun.file(zipFile).stream()) {
    unzip.push(chunk);
    if (failed) break;
  }
  if (!failed) unzip.push(new Uint8Array(0), true);
  await Promise.all(writes);
  if (failed) throw failed;
}
```

- [ ] **Step 5: Write `runtime.ts`**

Create `apps/agent/src/java/runtime.ts`:

```ts
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
```

- [ ] **Step 6: Run the tests to make sure they pass**

Run: `bun test apps/agent/test/java-runtime.test.ts && bun run typecheck`
Expected: 12 pass, and the typecheck is clean.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/java apps/agent/src/run apps/agent/src/commands.ts apps/agent/src/host/commands.ts apps/agent/test/run.test.ts apps/agent/test/java-runtime.test.ts
git commit -m "feat(agent): download and cache a Temurin JRE per Java major

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5"
```

---

### Task 2: Hosting, `profile run` and Docker use the managed JRE

**Files:**
- Modify: `apps/agent/src/host/deps.ts:27-28`, `apps/agent/src/host/prepare.ts` (the `Prepared` interface, the pre-claim section and the return), `apps/agent/src/host/run.ts:31`, `apps/agent/src/host/commands.ts:40-41`, `apps/agent/src/commands.ts` (`Deps.javaBin` doc and `cmdRun`), `apps/agent/src/cli.ts` (`main` and `USAGE`), `infra/docker/Dockerfile`
- Test: `apps/agent/test/host-fakes.ts`, `apps/agent/test/prepare.test.ts`, `apps/agent/test/hosted.test.ts`, `apps/agent/test/commands.test.ts`

**Interfaces:**
- Consumes: `javaFor(need, { cacheDir, fetch, userAgent, log, override })` from Task 1.
- Produces:
  - `SessionDeps.ensureJava: (need: { minecraft: string; javaMajor: number }) => Promise<string>` (replaces `checkJava`)
  - `SessionDeps.launch: (dir: string, marker: ServerMarker, javaBin: string) => ServerProcess`
  - `Prepared.javaBin: string`
  - `Harness.launches: { dir: string; javaBin: string }[]` in `test/host-fakes.ts`
  - `Deps.javaBin` is now documented as the `MC_JAVA` override, and `cli.ts` sets it from `process.env.MC_JAVA`.

- [ ] **Step 1: Update the fakes and write the failing tests**

In `apps/agent/test/host-fakes.ts`, add `launches: { dir: string; javaBin: string }[];` to `interface Harness` after `builds`, add `launches: [],` to the `h` object in `makeHarness`, and replace the `checkJava`/`launch` entries in `deps` with:

```ts
    ensureJava: async () => "/jre/bin/java",
    launch: (dir, _marker, javaBin) => {
      h.launches.push({ dir, javaBin });
      const s = new FakeServer(o.respond, events);
      h.servers.push(s);
      return s;
    },
```

In `apps/agent/test/hosted.test.ts`, add `javaBin: "/jre/bin/java",` to the `Prepared` literal in `started()` (after `address`). In the first test, change `const { h, done, server, unhooked } = await started();` to `const { h, p, done, server, unhooked } = await started();` and add after `expect(unhooked()).toBe(true);`:

```ts
  expect(h.launches).toEqual([{ dir: p.serverDir, javaBin: "/jre/bin/java" }]);
```

Append to `apps/agent/test/prepare.test.ts`:

```ts
test("gets Java before claiming, and hands it to the run phase", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.ensureJava = async (need) => {
    h.events.push(`java ${need.minecraft} ${need.javaMajor}`);
    return "/jre/bin/java";
  };
  const p = await prepare(h.deps);
  expect(h.events.slice(0, 3)).toEqual(["api:manifest", "java 26.3 25", "api:claim 100.64.0.3"]);
  expect(p.javaBin).toBe("/jre/bin/java");
});

test("a failed Java download never claims the lease", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.ensureJava = async () => {
    throw new UserError("Couldn't download Java 25 for this PC (offline). Check your internet and try again.");
  };
  await expect(prepare(h.deps)).rejects.toThrow("Couldn't download Java 25");
  expect(h.events.some((e) => e.startsWith("api:claim"))).toBe(false);
});
```

In `apps/agent/test/commands.test.ts`, add `chmodSync` to the `node:fs` import, then replace the test `"run refuses a Java that is too old"` with these two:

```ts
// Review focus 5
test("run refuses an MC_JAVA that is too old, after the EULA", async () => {
  const srv = join(dir, "srv");
  await Bun.write(join(srv, ".mc-host.json"), JSON.stringify({ profile: "test", minecraft: "26.3", javaMajor: 25, memory: { min: "1G", max: "1G" }, complete: true }));
  const old = join(dir, "java");
  writeFileSync(old, `#!/bin/sh\necho 'openjdk version "21.0.1"' >&2\n`);
  chmodSync(old, 0o755);
  deps.ask = async () => "yes";
  deps.javaBin = old;
  await expect(runCommand({ kind: "run", dir: srv }, deps)).rejects.toThrow("Minecraft 26.3 needs Java 25, but this PC has Java 21");
});

test("run without MC_JAVA downloads Java, and says so when it can't", async () => {
  const srv = join(dir, "srv");
  await Bun.write(join(srv, ".mc-host.json"), JSON.stringify({ profile: "test", minecraft: "26.3", javaMajor: 25, memory: { min: "1G", max: "1G" }, complete: true }));
  deps.ask = async () => "yes";
  await expect(runCommand({ kind: "run", dir: srv }, deps)).rejects.toThrow("Couldn't download Java 25 for this PC (Adoptium answered HTTP 500)");
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent`
Expected: FAIL. The typecheck-level errors show up as test failures: `ensureJava` isn't in `SessionDeps`, `p.javaBin` is undefined, and the run tests still hit the old order.

- [ ] **Step 3: Implement**

`apps/agent/src/host/deps.ts`: replace the two lines

```ts
  checkJava: (marker: ServerMarker) => void;
  launch: (dir: string, marker: ServerMarker) => ServerProcess;
```
with
```ts
  /** Path to a Java for this Minecraft version, downloading it the first time. */
  ensureJava: (need: { minecraft: string; javaMajor: number }) => Promise<string>;
  launch: (dir: string, marker: ServerMarker, javaBin: string) => ServerProcess;
```

`apps/agent/src/host/prepare.ts`: add to `interface Prepared` after `marker`:
```ts
  /** The java binary the server is launched with. */
  javaBin: string;
```
Replace
```ts
  if (!(await deps.ensureEula(serverDir))) throw new UserError("You need to agree to the EULA to host a server.");

  const address = deps.address();
```
with
```ts
  if (!(await deps.ensureEula(serverDir))) throw new UserError("You need to agree to the EULA to host a server.");
  // Java can be a 58 MB download, so it's fetched before claiming too.
  const javaBin = await deps.ensureJava(lock);

  const address = deps.address();
```
Delete the line `deps.checkJava(marker);` and add `javaBin,` to the returned object after `marker,`.

`apps/agent/src/host/run.ts:31`: `const server = deps.launch(p.serverDir, p.marker, p.javaBin);`

`apps/agent/src/host/commands.ts`: replace the import `import { requireJava } from "../java/version";` with `import { javaFor } from "../java/runtime";`, and the two entries with:
```ts
    ensureJava: (need) =>
      javaFor(need, { cacheDir: deps.cacheDir, fetch: deps.fetch, userAgent: USER_AGENT, log: deps.log, override: deps.javaBin }),
    launch: (dir, marker, javaBin) => spawnProcess(javaCommand(marker, javaBin), dir, (text) => process.stdout.write(text)),
```

`apps/agent/src/commands.ts`: replace the import `import { requireJava } from "./java/version";` with `import { javaFor } from "./java/runtime";`. In `Deps`, document the override:
```ts
  /** MC_JAVA: run servers with this java instead of the managed one. */
  javaBin?: string;
```
Replace the body of `cmdRun` from `requireJava(marker, deps.javaBin);` to the `runServer` call with:
```ts
  const agreed = await ensureEula({ configDir: deps.configDir, serverDir: cmd.dir, ask: deps.ask, log: deps.log });
  if (!agreed) throw new UserError("You need to agree to the EULA to run a server.");
  const javaBin = await javaFor(marker, { cacheDir: deps.cacheDir, fetch: deps.fetch, userAgent: USER_AGENT, log: deps.log, override: deps.javaBin });
  const started = (deps.now ?? Date.now)();
  const code = await runServer({ dir: cmd.dir, marker, javaBin });
```

`apps/agent/src/cli.ts`: in `main`, add `javaBin: process.env.MC_JAVA || undefined,` to the deps object after `env`. Replace the last line of `USAGE`:
```
Options: --profiles <folder> (default: profiles)
MC_JAVA=<path to java> runs servers with that Java instead of downloading one.`;
```

`infra/docker/Dockerfile`: replace the whole file with
```dockerfile
# Built by scripts/install.sh around a freshly compiled mc-host binary.
# No Java in the image: mc-host downloads the Java each world needs into /data/cache/mc-host/java.
FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY mc-host /usr/local/bin/mc-host
ENV MC_DATA_DIR=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache
WORKDIR /data
ENTRYPOINT ["mc-host"]
CMD ["start"]
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `bun test apps/agent && bun run typecheck`
Expected: every test passes (the integration test skips without `INTEGRATION=1`), and the typecheck is clean.

- [ ] **Step 5: Check that the image builds**

Build the image the way `install.sh` does, from a folder that holds the Dockerfile and a compiled `mc-host`:
```bash
bun run --cwd apps/agent build
mkdir -p /tmp/mc-img && cp apps/agent/dist/mc-host infra/docker/Dockerfile /tmp/mc-img/
docker build -q -t mc-host:java-check /tmp/mc-img && docker run --rm --entrypoint sh mc-host:java-check -c 'command -v java || echo no-java; command -v tar'
```
Expected: `no-java`, then `/usr/bin/tar`. Remove the image with `docker rmi mc-host:java-check`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent infra/docker/Dockerfile
git commit -m "feat(agent): host, run and Docker on the managed JRE; MC_JAVA override

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5"
```

---

### Task 3: Datapack index

**Files:**
- Create: `apps/agent/src/packs/index.ts`
- Test: `apps/agent/test/packs-index.test.ts`

**Interfaces:**
- Produces:
  - `interface PackIndex { file: string; paths: string[]; text: string }`: `paths` are the file entries (no directories), sorted; `text` is every `.json`/`.mcfunction`/`.mcmeta` file, joined and lower-cased
  - `indexPack(packsDir: string, file: string): Promise<PackIndex>`
  - `provides(pack: PackIndex, id: string): boolean`: true when the pack has `data/<ns>/…/<path>.<ext>`
  - `mentions(pack: PackIndex, id: string): boolean`: false for any `minecraft:` id

- [ ] **Step 1: Write the failing tests**

Create `apps/agent/test/packs-index.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { indexPack, mentions, provides } from "../src/packs/index";

const enc = (s: string) => new TextEncoder().encode(s);
const FILE = "player head drops v1.1.17 (MC 26.2).zip";

async function heads() {
  const dir = mkdtempSync(join(tmpdir(), "mc-packidx-"));
  writeFileSync(
    join(dir, FILE),
    zipSync(
      {
        "pack.mcmeta": enc('{"pack":{"min_format":101}}'),
        "data/minecraft/loot_table/entities/player.json": enc('{"value":"Player_Heads:entities/player"}'),
        "data/player_heads/loot_table/entities/player.json": enc('{"value":"graves:entities/player"}'),
        "data/player_heads/function/tick.mcfunction": enc("say hi"),
        "data/player_heads/structure/head.nbt": new Uint8Array([1, 2, 3]),
      },
      { level: 0 },
    ),
  );
  return { dir, pack: await indexPack(dir, FILE) };
}

test("indexes entry paths and the text of json, mcfunction and mcmeta files", async () => {
  const { pack } = await heads();
  expect(pack.file).toBe(FILE);
  expect(pack.paths).toEqual([
    "data/minecraft/loot_table/entities/player.json",
    "data/player_heads/function/tick.mcfunction",
    "data/player_heads/loot_table/entities/player.json",
    "data/player_heads/structure/head.nbt",
    "pack.mcmeta",
  ]);
  expect(pack.text).toContain("graves:entities/player");
  expect(pack.text).toContain("say hi");
  expect(pack.text).toBe(pack.text.toLowerCase());
});

test("provides: the id's namespace folder holds a file with that path, whatever the type folder", async () => {
  const { pack } = await heads();
  expect(provides(pack, "minecraft:entities/player")).toBe(true);
  expect(provides(pack, "player_heads:tick")).toBe(true);
  expect(provides(pack, "player_heads:head")).toBe(true);
  expect(provides(pack, "player_heads:entities/zombie")).toBe(false);
  expect(provides(pack, "graves:entities/player")).toBe(false);
});

test("mentions: any id in the text, case-insensitive, except minecraft ones", async () => {
  const { pack } = await heads();
  expect(mentions(pack, "graves:entities/player")).toBe(true);
  expect(mentions(pack, "player_heads:entities/player")).toBe(true);
  expect(mentions(pack, "minecraft:entities/player")).toBe(false);
  expect(mentions(pack, "more_mob_heads:entities/shulker")).toBe(false);
});

test("a file that isn't a zip is a plain error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-packidx-"));
  writeFileSync(join(dir, "broken.zip"), "not a zip");
  await expect(indexPack(dir, "broken.zip")).rejects.toThrow("broken.zip isn't a readable zip");
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/packs-index.test.ts`
Expected: FAIL with `Cannot find module '../src/packs/index'`.

- [ ] **Step 3: Implement**

Create `apps/agent/src/packs/index.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { unzipSync } from "fflate";

/** What a datapack zip contains, for blaming it from log lines. */
export interface PackIndex {
  file: string;
  /** File entries, sorted. */
  paths: string[];
  /** Every .json/.mcfunction/.mcmeta file, joined and lower-cased. */
  text: string;
}

const TEXT = /\.(json|mcfunction|mcmeta)$/i;

export async function indexPack(packsDir: string, file: string): Promise<PackIndex> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await readFile(join(packsDir, file))));
  } catch (err) {
    throw new UserError(`${file} isn't a readable zip (${(err as Error).message}).`);
  }
  const paths = Object.keys(entries).filter((p) => !p.endsWith("/")).sort();
  const decoder = new TextDecoder();
  const text = paths
    .filter((p) => TEXT.test(p))
    .map((p) => decoder.decode(entries[p]))
    .join("\n")
    .toLowerCase();
  return { file, paths, text };
}

function split(id: string): [string, string] {
  const i = id.indexOf(":");
  return [id.slice(0, i), id.slice(i + 1)];
}

/** The pack has data/<namespace>/<any type folders>/<path>.<ext>. */
export function provides(pack: PackIndex, id: string): boolean {
  const [ns, path] = split(id.toLowerCase());
  const prefix = `data/${ns}/`;
  return pack.paths.some((p) => p.toLowerCase().startsWith(prefix) && p.toLowerCase().replace(/\.[^./]+$/, "").endsWith(`/${path}`));
}

/** The pack's files mention the id. minecraft: ids are in every pack, so they never count. */
export function mentions(pack: PackIndex, id: string): boolean {
  const lower = id.toLowerCase();
  return !lower.startsWith("minecraft:") && pack.text.includes(lower);
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `bun test apps/agent/test/packs-index.test.ts && bun run typecheck`
Expected: 4 pass, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/packs/index.ts apps/agent/test/packs-index.test.ts
git commit -m "feat(agent): index datapack zips for blaming them from log lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5"
```

---

### Task 4: Log scanning and attribution

**Files:**
- Create: `apps/agent/src/packs/logscan.ts`
- Uses: `apps/agent/test/fixtures/packs/{baseline,fatal,clean}.log`, committed with this plan: real 26.3 boots of `adventure` with no packs loaded, with all ten VT 26.2 packs, and with the eight clean ones. The scratch path was replaced with `/srv/mc`.
- Test: `apps/agent/test/logscan.test.ts`

**Interfaces:**
- Consumes: `PackIndex`, `provides`, `mentions` from Task 3.
- Produces:
  - `interface LogError { lines: string[] }`: `lines[0]` is the header message without timestamp or thread; the rest are continuation lines without stack frames
  - `scanLog(lines: string[]): LogError[]`
  - `errorKey(e: LogError): string`: numbers normalised to `#`
  - `resourceIds(line: string): string[]`, `packFileMentions(line: string): string[]`
  - `attribute(errors: LogError[], packs: PackIndex[]): { blamed: Map<string, string[]>; unattributed: LogError[] }`: map from pack file to the lines that blamed it

- [ ] **Step 1: Write the failing tests**

Create `apps/agent/test/logscan.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackIndex } from "../src/packs/index";
import { attribute, errorKey, packFileMentions, resourceIds, scanLog } from "../src/packs/logscan";

const log = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "packs", `${name}.log`), "utf8").split(/\r?\n/);
const firstLines = (name: string) => scanLog(log(name)).map((e) => e.lines[0]);
const pack = (file: string, text = "", paths: string[] = []): PackIndex => ({ file, paths, text: text.toLowerCase() });

const UNBOUND =
  "java.lang.IllegalStateException: Unbound values in registry ResourceKey[minecraft:root / minecraft:loot_table]: [graves:entities/player, more_mob_heads:entities/shulker]";
const HEADS = pack("player head drops v1.1.17 (MC 26.2).zip", '{"value":"graves:entities/player"}');
const SHELLS = pack("double shulker shells v1.3.17 (MC 26.2).zip", '{"value":"more_mob_heads:entities/shulker"}');
const AFK = pack("afk display v1.1.17 (MC 26.2).zip", '{"type":"minecraft:loot_table"}');

test("the no-pack boot has the two errors the mods always log", () => {
  expect(firstLines("baseline")).toEqual([
    "No key layers in MapLike[{}]",
    "Failed to load function nova_structures:structure_search/dnt/underground",
  ]);
});

test("the fatal boot keeps the registry block without stack frames, and drops the 'can't proceed' line", () => {
  const errors = scanLog(log("fatal"));
  expect(errors.map((e) => e.lines[0])).toEqual(["No key layers in MapLike[{}]", "Registry loading errors:"]);
  expect(errors[1]!.lines).toEqual([
    "Registry loading errors:",
    "> Errors in registry minecraft:root:",
    ">> Errors in element minecraft:loot_table:",
    UNBOUND,
  ]);
});

test("the clean boot has only the baseline's errors, even with other timestamps and threads", () => {
  const known = new Set(scanLog(log("baseline")).map(errorKey));
  expect(scanLog(log("clean")).filter((e) => !known.has(errorKey(e)))).toEqual([]);
});

// Review focus 1
test("errorKey ignores numbers, so timings don't get past the baseline", () => {
  const a = scanLog(["[10:00:00] [main/ERROR]: Took 12 ms to load 3 things"]);
  const b = scanLog(["[11:22:33] [Worker-Main-9/ERROR]: Took 480 ms to load 3 things"]);
  expect(errorKey(a[0]!)).toBe(errorKey(b[0]!));
});

test("only data-related WARN lines count", () => {
  const errors = scanLog([
    "[10:00:00] [main/WARN]: Reference map 'x.refmap.json' for x.mixins.json could not be read.",
    "[10:00:00] [main/WARN]: Pack file/old.zip is incompatible with this version",
    "[10:00:00] [main/INFO]: Found new data pack file/old.zip, loading it automatically",
  ]);
  expect(errors.map((e) => e.lines[0])).toEqual(["Pack file/old.zip is incompatible with this version"]);
});

test("resource ids and pack files are pulled out of a line", () => {
  expect(resourceIds(UNBOUND)).toEqual(["minecraft:root", "minecraft:loot_table", "graves:entities/player", "more_mob_heads:entities/shulker"]);
  expect(packFileMentions("Found new data pack file/afk display v1.1.17 (MC 26.2).zip, loading it automatically")).toEqual([
    "afk display v1.1.17 (MC 26.2).zip",
  ]);
});

// Review focus 2
test("the Phase 1 failure blames exactly the two packs that mention the unbound loot tables", () => {
  const known = new Set(scanLog(log("baseline")).map(errorKey));
  const errors = scanLog(log("fatal")).filter((e) => !known.has(errorKey(e)));
  const { blamed, unattributed } = attribute(errors, [AFK, HEADS, SHELLS]);
  expect([...blamed.keys()].sort()).toEqual([SHELLS.file, HEADS.file].sort());
  expect(blamed.get(HEADS.file)).toEqual([UNBOUND]);
  expect(unattributed).toEqual([]);
});

test("a line naming a pack's file, or an id the pack provides, blames it too", () => {
  const vt = pack("more effective tools v1.0.11 (MC 26.2).zip", "", ["data/vt/recipe/axe.json"]);
  const byFile = scanLog(["[10:00:00] [main/WARN]: Pack file/more effective tools v1.0.11 (MC 26.2).zip is incompatible"]);
  const byId = scanLog(["[10:00:00] [Worker-Main-1/ERROR]: Couldn't parse element vt:axe"]);
  expect([...attribute(byFile, [vt, AFK]).blamed.keys()]).toEqual([vt.file]);
  expect([...attribute(byId, [vt, AFK]).blamed.keys()]).toEqual([vt.file]);
});

test("an error no pack can be tied to is unattributed", () => {
  const errors = scanLog(["[10:00:00] [main/ERROR]: Something broke"]);
  expect(attribute(errors, [AFK, HEADS])).toEqual({ blamed: new Map(), unattributed: errors });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/logscan.test.ts`
Expected: FAIL with `Cannot find module '../src/packs/logscan'`.

- [ ] **Step 3: Implement**

Create `apps/agent/src/packs/logscan.ts`:

```ts
import { mentions, provides, type PackIndex } from "./index";

/** One logged error: the header message, then its continuation lines without stack frames. */
export interface LogError {
  lines: string[];
}

const HEADER = /^\[\d{2}:\d{2}:\d{2}\] \[[^\]]*\/(ERROR|FATAL|WARN|INFO|DEBUG|TRACE)\]: (.*)$/;
const DATA_WARN = /data ?pack|failed to (load|parse)|couldn't (load|parse)|parsing error|incompatible/i;
/** Means the server gave up; the boot's "started" flag reports it, so it isn't an error to blame. */
const GAVE_UP = /Failed to load datapacks, can't proceed/;
const STACK = /^\s+at |^\s*\.\.\. \d+ more\s*$/;
const RESOURCE_ID = /(?<![\w.\/-])([a-z0-9_.-]+:[a-z0-9_.\/-]+)/g;
const PACK_FILE = /file\/(.+?\.zip)/gi;

export function scanLog(lines: string[]): LogError[] {
  const out: LogError[] = [];
  let current: LogError | null = null;
  for (const line of lines) {
    const m = HEADER.exec(line);
    if (m) {
      const [, level, message] = m as unknown as [string, string, string];
      const keep = (level === "ERROR" || level === "FATAL" || (level === "WARN" && DATA_WARN.test(message))) && !GAVE_UP.test(message);
      current = keep ? { lines: [message] } : null;
      if (current) out.push(current);
      continue;
    }
    if (current && line.trim() && !STACK.test(line)) current.lines.push(line.trimEnd());
  }
  return out;
}

/** Compare errors across boots: same text, whatever the numbers in it. */
export function errorKey(e: LogError): string {
  return e.lines.join("\n").replace(/\d+/g, "#");
}

export function resourceIds(line: string): string[] {
  return [...line.matchAll(RESOURCE_ID)].map((m) => m[1]!);
}

export function packFileMentions(line: string): string[] {
  return [...line.matchAll(PACK_FILE)].map((m) => m[1]!);
}

function blamedBy(line: string, packs: PackIndex[]): string[] {
  const files = packFileMentions(line);
  const ids = resourceIds(line);
  return packs.filter((p) => files.includes(p.file) || ids.some((id) => provides(p, id) || mentions(p, id))).map((p) => p.file);
}

/** Which packs each error line points at. Errors whose lines point at none are unattributed. */
export function attribute(errors: LogError[], packs: PackIndex[]): { blamed: Map<string, string[]>; unattributed: LogError[] } {
  const blamed = new Map<string, string[]>();
  const unattributed: LogError[] = [];
  for (const e of errors) {
    let hit = false;
    for (const line of e.lines) {
      for (const file of blamedBy(line, packs)) {
        hit = true;
        const lines = blamed.get(file) ?? [];
        if (!lines.includes(line)) lines.push(line);
        blamed.set(file, lines);
      }
    }
    if (!hit) unattributed.push(e);
  }
  return { blamed, unattributed };
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `bun test apps/agent/test/logscan.test.ts && bun run typecheck`
Expected: 9 pass, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/packs/logscan.ts apps/agent/test/logscan.test.ts
git commit -m "feat(agent): scan server logs for datapack errors and blame packs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5"
```

---

### Task 5: The check loop and the report

**Files:**
- Create: `apps/agent/src/packs/check.ts`
- Test: `apps/agent/test/check-packs.test.ts`

**Interfaces:**
- Consumes: `scanLog`, `errorKey`, `attribute`, `LogError` from Task 4; `PackIndex` from Task 3; `packNameFromFilename` from `src/server/packs.ts`.
- Produces:
  - `interface BootResult { lines: string[]; started: boolean }`
  - `type Boot = (packFiles: string[], label: string) => Promise<BootResult>`
  - `interface CheckReport { packs: string[]; failed: Map<string, string[]>; together: { files: string[]; lines: string[] } | null; boots: number }`
  - `checkPacks(packs: PackIndex[], boot: Boot, log: (line: string) => void): Promise<CheckReport>`
  - `formatReport(r: CheckReport): { lines: string[]; summary: string; ok: boolean }`
  - Boot labels: `"baseline"`, `"all"`, and `"alone-<pack name>"`

- [ ] **Step 1: Write the failing tests**

Create `apps/agent/test/check-packs.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPacks, formatReport, type BootResult, type CheckReport } from "../src/packs/check";
import type { PackIndex } from "../src/packs/index";

const log = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "packs", `${name}.log`), "utf8").split(/\r?\n/);
const pack = (file: string, text = ""): PackIndex => ({ file, paths: [], text: text.toLowerCase() });
const HEADS = pack("player head drops v1.1.17 (MC 26.2).zip", '{"value":"graves:entities/player"}');
const SHELLS = pack("double shulker shells v1.3.17 (MC 26.2).zip", '{"value":"more_mob_heads:entities/shulker"}');
const AFK = pack("afk display v1.1.17 (MC 26.2).zip", '{"type":"minecraft:loot_table"}');
const A = pack("a.zip");
const B = pack("b.zip");
const DONE = '[10:00:09] [Server thread/INFO]: Done (1.0s)! For help, type "help"';
const ok = (...lines: string[]): BootResult => ({ lines: [...lines, DONE], started: true });
const broke = (started: boolean): BootResult => ({ lines: ["[10:00:01] [main/ERROR]: Something broke"], started });

function scripted(answer: (files: string[]) => BootResult) {
  const calls: { files: string[]; label: string }[] = [];
  return {
    calls,
    boot: async (files: string[], label: string) => {
      calls.push({ files, label });
      return answer(files);
    },
  };
}

// Review focus 2
test("the Phase 1 failure: two packs blamed from the fatal boot, then the rest boot clean", async () => {
  const s = scripted((files) => {
    if (files.length === 0) return { lines: log("baseline"), started: true };
    if (files.includes(HEADS.file) || files.includes(SHELLS.file)) return { lines: log("fatal"), started: false };
    return { lines: log("clean"), started: true };
  });
  const r = await checkPacks([AFK, HEADS, SHELLS], s.boot, () => {});
  expect(s.calls).toEqual([
    { files: [], label: "baseline" },
    { files: [AFK.file, HEADS.file, SHELLS.file], label: "all" },
    { files: [AFK.file], label: "all" },
  ]);
  expect([...r.failed.keys()].sort()).toEqual([HEADS.file, SHELLS.file].sort());
  expect(r.failed.get(SHELLS.file)![0]).toContain("Unbound values in registry");
  expect(r).toMatchObject({ together: null, boots: 3, packs: [AFK.file, SHELLS.file, HEADS.file] });
});

test("errors the no-pack boot also has are ignored", async () => {
  const s = scripted(() => ok("[10:00:01] [main/ERROR]: Mod noise"));
  const r = await checkPacks([A, B], s.boot, () => {});
  expect(r.failed.size).toBe(0);
  expect(r.boots).toBe(2);
});

test("an error that names no pack: each pack is booted alone, and the one that fails alone is named", async () => {
  const s = scripted((files) => (files.includes(B.file) ? broke(false) : ok()));
  const r = await checkPacks([A, B], s.boot, () => {});
  expect(s.calls.map((c) => c.label)).toEqual(["baseline", "all", "alone-a", "alone-b", "all"]);
  expect([...r.failed]).toEqual([[B.file, ["Something broke"]]]);
  expect(r.together).toBeNull();
});

test("packs that only fail together are reported together", async () => {
  const s = scripted((files) => (files.length === 2 ? broke(true) : ok()));
  const r = await checkPacks([A, B], s.boot, () => {});
  expect(r.failed.size).toBe(0);
  expect(r.together).toEqual({ files: [A.file, B.file], lines: ["Something broke"] });
});

test("a boot that doesn't start and logs nothing new still fails its pack", async () => {
  const s = scripted((files) => (files.length ? { lines: [], started: false } : ok()));
  const r = await checkPacks([A], s.boot, () => {});
  expect([...r.failed]).toEqual([[A.file, ["The server didn't finish starting."]]]);
});

test("a server that doesn't start without packs stops the check", async () => {
  const s = scripted(() => broke(false));
  await expect(checkPacks([A], s.boot, () => {})).rejects.toThrow(
    "The server doesn't start even without datapacks, so the packs can't be checked. Fix that first.\nSomething broke",
  );
});

test("the report: ok and FAIL lines, at most 3 evidence lines cut to 300 characters", () => {
  const long = "x".repeat(400);
  const r: CheckReport = { packs: [A.file, B.file], failed: new Map([[B.file, ["one", "two", "three", long]]]), together: null, boots: 4 };
  const out = formatReport(r);
  expect(out.lines).toEqual(["  ok    a.zip", "  FAIL  b.zip", "        one", "        two", "        three"]);
  expect(out.summary).toBe("1 of 2 datapacks have errors (4 boots).");
  expect(out.ok).toBe(false);
  const cut = formatReport({ ...r, failed: new Map([[B.file, [long]]]) });
  expect(cut.lines[2]).toBe(`        ${"x".repeat(299)}…`);
});

test("the report for packs that only fail together, and for a clean run", () => {
  const together = formatReport({ packs: [A.file, B.file], failed: new Map(), together: { files: [A.file, B.file], lines: ["Something broke"] }, boots: 4 });
  expect(together.lines).toEqual(["  ok    a.zip", "  ok    b.zip", "These datapacks only fail together: a.zip, b.zip", "        Something broke"]);
  expect(together.summary).toBe("0 of 2 datapacks have errors on their own, but 2 fail together (4 boots).");
  expect(together.ok).toBe(false);
  expect(formatReport({ packs: [A.file], failed: new Map(), together: null, boots: 2 })).toEqual({
    lines: ["  ok    a.zip"],
    summary: "The datapack loaded without errors (2 boots).",
    ok: true,
  });
  expect(formatReport({ packs: [A.file, B.file], failed: new Map(), together: null, boots: 2 }).summary).toBe(
    "All 2 datapacks loaded without errors (2 boots).",
  );
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/check-packs.test.ts`
Expected: FAIL with `Cannot find module '../src/packs/check'`.

- [ ] **Step 3: Implement**

Create `apps/agent/src/packs/check.ts`:

```ts
import { UserError } from "@mc/profile";
import { packNameFromFilename } from "../server/packs";
import type { PackIndex } from "./index";
import { attribute, errorKey, scanLog, type LogError } from "./logscan";

export interface BootResult {
  lines: string[];
  /** The log reached "Done (". */
  started: boolean;
}

/** Boot the scratch server with exactly these pack files; label names the boot's log file. */
export type Boot = (packFiles: string[], label: string) => Promise<BootResult>;

export interface CheckReport {
  /** Every pack checked, sorted. */
  packs: string[];
  /** Pack file → the log lines that blamed it. */
  failed: Map<string, string[]>;
  /** Packs that pass alone but not together, with the errors nobody could be blamed for. */
  together: { files: string[]; lines: string[] } | null;
  boots: number;
}

const DIDNT_START = "The server didn't finish starting.";
const EVIDENCE_LINES = 3;
const EVIDENCE_CHARS = 300;

const linesOf = (errors: LogError[]) => errors.flatMap((e) => e.lines);

export async function checkPacks(packs: PackIndex[], boot: Boot, log: (line: string) => void): Promise<CheckReport> {
  let boots = 0;
  const run = (files: string[], label: string) => {
    boots++;
    return boot(files, label);
  };

  log("Booting without datapacks first, to see which errors the mods cause on their own…");
  const base = await run([], "baseline");
  const baseErrors = scanLog(base.lines);
  if (!base.started) {
    const last = linesOf(baseErrors).slice(-5);
    throw new UserError(
      `The server doesn't start even without datapacks, so the packs can't be checked. Fix that first.${last.length ? `\n${last.join("\n")}` : ""}`,
    );
  }
  const known = new Set(baseErrors.map(errorKey));
  const fresh = (r: BootResult) => scanLog(r.lines).filter((e) => !known.has(errorKey(e)));

  const failed = new Map<string, string[]>();
  let together: CheckReport["together"] = null;
  let remaining = packs;
  while (remaining.length) {
    log(`Booting with ${remaining.length} datapacks…`);
    const r = await run(remaining.map((p) => p.file), "all");
    const errors = fresh(r);
    if (r.started && errors.length === 0) break;

    const { blamed, unattributed } = attribute(errors, remaining);
    if (blamed.size) {
      for (const [file, lines] of blamed) failed.set(file, lines);
      remaining = remaining.filter((p) => !blamed.has(p.file));
      continue;
    }

    log(`Some errors don't point at a pack, so each of the ${remaining.length} datapacks is booted on its own…`);
    const alone = new Map<string, string[]>();
    for (const p of remaining) {
      const r1 = await run([p.file], `alone-${packNameFromFilename(p.file) ?? p.file}`);
      const e1 = fresh(r1);
      if (!r1.started || e1.length) alone.set(p.file, e1.length ? linesOf(e1) : [DIDNT_START]);
    }
    if (alone.size === 0) {
      const lines = linesOf(unattributed);
      together = { files: remaining.map((p) => p.file), lines: lines.length ? lines : [DIDNT_START] };
      break;
    }
    for (const [file, lines] of alone) failed.set(file, lines);
    remaining = remaining.filter((p) => !alone.has(p.file));
  }
  return { packs: packs.map((p) => p.file).sort(), failed, together, boots };
}

const cut = (line: string) => (line.length > EVIDENCE_CHARS ? `${line.slice(0, EVIDENCE_CHARS - 1)}…` : line);
const evidence = (lines: string[]) => lines.slice(0, EVIDENCE_LINES).map((l) => `        ${cut(l)}`);

export function formatReport(r: CheckReport): { lines: string[]; summary: string; ok: boolean } {
  const lines: string[] = [];
  for (const file of r.packs) {
    const bad = r.failed.get(file);
    lines.push(`  ${bad ? "FAIL" : "ok  "}  ${file}`);
    if (bad) lines.push(...evidence(bad));
  }
  if (r.together) {
    lines.push(`These datapacks only fail together: ${r.together.files.join(", ")}`);
    lines.push(...evidence(r.together.lines));
  }
  const n = r.packs.length;
  const boots = `(${r.boots} boots)`;
  if (r.together) {
    return { lines, summary: `${r.failed.size} of ${n} datapacks have errors on their own, but ${r.together.files.length} fail together ${boots}.`, ok: false };
  }
  if (r.failed.size) return { lines, summary: `${r.failed.size} of ${n} datapacks have errors ${boots}.`, ok: false };
  return { lines, summary: `${n === 1 ? "The datapack" : `All ${n} datapacks`} loaded without errors ${boots}.`, ok: true };
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `bun test apps/agent/test/check-packs.test.ts && bun run typecheck`
Expected: 8 pass, and the typecheck is clean. The first test's `packs` order is `sort()` order: `afk…`, `double…`, `player…`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/packs/check.ts apps/agent/test/check-packs.test.ts
git commit -m "feat(agent): datapack check loop with a baseline, re-boots and isolation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5"
```

---

### Task 6: The real boot

**Files:**
- Modify: `apps/agent/src/host/console.ts` (`ServerProcess.kill`, the `spawnProcess` stderr option, `exited` waiting for stdout)
- Modify: `apps/agent/test/host-fakes.ts` (`FakeServer.kill`)
- Create: `apps/agent/src/packs/boot.ts`
- Test: `apps/agent/test/boot.test.ts`

**Interfaces:**
- Consumes: `Boot`, `BootResult` from Task 5; `javaCommand`, `ServerConsole`, `spawnProcess` from `src/host/console.ts`; `ServerMarker` from `src/server/build.ts`.
- Produces:
  - `ServerProcess.kill(): void`
  - `spawnProcess(cmd, cwd, echo, o?: { stderr?: "inherit" | "ignore" })`; `exited` now resolves only after stdout is drained
  - `createBoot(o: BootOptions): Boot` with `interface BootOptions { serverDir: string; levelName: string; packsDir: string; javaBin: string; marker: ServerMarker; logsDir: string; startTimeoutMs?: number; stopTimeoutMs?: number }`
  - `START_TIMEOUT_MS = 180_000`, `STOP_TIMEOUT_MS = 60_000`

- [ ] **Step 1: Write the failing tests**

Create `apps/agent/test/boot.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoot, type BootOptions } from "../src/packs/boot";
import { MARKER } from "./host-fakes";

let root: string;
let o: BootOptions;
const PACK = "afk display v1.1.17 (MC 26.2).zip";

/** A fake java: prints what it's told, from the server folder, like the real one. */
function java(...script: string[]) {
  const path = join(root, "java");
  writeFileSync(path, ["#!/bin/sh", ...script].join("\n") + "\n");
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-boot-"));
  mkdirSync(join(root, "server"));
  mkdirSync(join(root, "packs"));
  writeFileSync(join(root, "packs", PACK), "zip");
  o = { serverDir: join(root, "server"), levelName: "check", packsDir: join(root, "packs"), javaBin: join(root, "java"), marker: MARKER, logsDir: join(root, "logs") };
});

const LIST = `echo "[10:00:00] [main/INFO]: packs: $(ls check/datapacks | tr '\\n' ',')"`;
const DONE = `echo '[10:00:01] [Server thread/INFO]: Done (1.0s)! For help, type "help"'`;

// Review focus 2
test("copies the packs into a fresh world, stops the server after Done, and keeps the log", async () => {
  java(LIST, DONE, "read cmd", 'echo "[10:00:02] [Server thread/INFO]: got $cmd"');
  const boot = createBoot(o);
  const r = await boot([PACK], "all");
  expect(r.started).toBe(true);
  expect(r.lines).toContain(`[10:00:00] [main/INFO]: packs: ${PACK},`);
  expect(r.lines).toContain("[10:00:02] [Server thread/INFO]: got stop");
  expect(readFileSync(join(root, "logs", "01-all.log"), "utf8")).toContain("got stop");
});

test("wipes the world between boots", async () => {
  java(LIST, DONE, "read cmd");
  const boot = createBoot(o);
  await boot([PACK], "all");
  writeFileSync(join(o.serverDir, "check", "level.dat"), "old world");
  const r = await boot([], "baseline");
  expect(r.lines).toContain("[10:00:00] [main/INFO]: packs: ");
  expect(existsSync(join(o.serverDir, "check", "level.dat"))).toBe(false);
  expect(existsSync(join(root, "logs", "02-baseline.log"))).toBe(true);
});

test("a server that exits before Done didn't start, and its last lines are kept", async () => {
  java('echo "[10:00:01] [Worker-Main-2/ERROR]: Registry loading errors:"', "exit 1");
  const r = await createBoot(o)([PACK], "all");
  expect(r).toEqual({ lines: ["[10:00:01] [Worker-Main-2/ERROR]: Registry loading errors:"], started: false });
});

// Review focus 3
test("a server that never reaches Done is killed", async () => {
  java('echo "[10:00:00] [main/INFO]: loading"', "exec sleep 30");
  const r = await createBoot({ ...o, startTimeoutMs: 200 })([], "baseline");
  expect(r.started).toBe(false);
  expect(r.lines.at(-1)).toBe("mc-host: the server didn't finish starting in time, so it was stopped.");
});

// Review focus 3
test("a server that ignores stop is killed", async () => {
  java(DONE, "exec sleep 30");
  const r = await createBoot({ ...o, stopTimeoutMs: 200 })([], "baseline");
  expect(r.started).toBe(true);
  expect(r.lines.at(-1)).toBe("mc-host: the server didn't stop in time, so it was killed.");
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/boot.test.ts`
Expected: FAIL with `Cannot find module '../src/packs/boot'`.

- [ ] **Step 3: Extend `ServerProcess` and `spawnProcess`**

In `apps/agent/src/host/console.ts`, add to `interface ServerProcess` after `exited`:
```ts
  /** Kill the process outright (the pack check's timeouts). */
  kill(): void;
```
Replace `spawnProcess` with:
```ts
/**
 * Start the server with piped stdin/stdout; `echo` receives the raw output for the terminal.
 * `exited` resolves once stdout is drained too, so no final line is lost.
 */
export function spawnProcess(
  cmd: string[],
  cwd: string,
  echo: (text: string) => void,
  o: { stderr?: "inherit" | "ignore" } = {},
): ServerProcess {
  const proc = Bun.spawn(cmd, { cwd, stdin: "pipe", stdout: "pipe", stderr: o.stderr ?? "inherit" });
  const listeners: ((line: string) => void)[] = [];
  const split = new LineSplitter();
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      echo(text);
      for (const line of split.push(text)) for (const cb of listeners) cb(line);
    }
  })().catch(() => {});
  return {
    write(line) {
      try {
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
      } catch {
        // The server already exited; the session notices through `exited`.
      }
    },
    onLine(cb) {
      listeners.push(cb);
    },
    exited: proc.exited.then(async (code) => {
      await reading;
      return code;
    }),
    kill() {
      proc.kill("SIGKILL");
    },
  };
}
```

In `apps/agent/test/host-fakes.ts`, add to `class FakeServer` after `exit`:
```ts
  kill(): void {
    this.exit(137);
  }
```

Run: `bun test apps/agent && bun run typecheck`
Expected: every existing test still passes. `boot.test.ts` still fails on the missing module.

- [ ] **Step 4: Implement `boot.ts`**

Create `apps/agent/src/packs/boot.ts`:

```ts
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { javaCommand, ServerConsole, spawnProcess } from "../host/console";
import type { ServerMarker } from "../server/build";
import type { Boot } from "./check";

export const START_TIMEOUT_MS = 3 * 60_000;
export const STOP_TIMEOUT_MS = 60_000;

export interface BootOptions {
  /** A server folder made by buildServer, with level-name set to levelName. */
  serverDir: string;
  levelName: string;
  packsDir: string;
  javaBin: string;
  marker: ServerMarker;
  /** Each boot's log is written here as <NN>-<label>.log. */
  logsDir: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** Boots the scratch server once per call: fresh world, the given packs, stop at Done. */
export function createBoot(o: BootOptions): Boot {
  let n = 0;
  return async (files, label) => {
    const world = join(o.serverDir, o.levelName);
    await rm(world, { recursive: true, force: true });
    await mkdir(join(world, "datapacks"), { recursive: true });
    for (const f of files) await copyFile(join(o.packsDir, f), join(world, "datapacks", f));

    const proc = spawnProcess(javaCommand(o.marker, o.javaBin), o.serverDir, () => {}, { stderr: "ignore" });
    const con = new ServerConsole(proc);
    const lines: string[] = [];
    con.onLine((line) => lines.push(line));
    let exited = false;
    const exit = proc.exited.then(() => {
      exited = true;
    });

    let started = false;
    try {
      await con.waitFor(/Done \(/, o.startTimeoutMs ?? START_TIMEOUT_MS);
      started = true;
      con.send("stop");
      await Promise.race([exit, Bun.sleep(o.stopTimeoutMs ?? STOP_TIMEOUT_MS)]);
    } catch {
      // It exited before Done, or never got there; `exited` tells which.
    }
    if (!exited) {
      lines.push(
        started
          ? "mc-host: the server didn't stop in time, so it was killed."
          : "mc-host: the server didn't finish starting in time, so it was stopped.",
      );
      proc.kill();
    }
    await exit;

    await mkdir(o.logsDir, { recursive: true });
    await writeFile(join(o.logsDir, `${String(++n).padStart(2, "0")}-${label}.log`), lines.join("\n") + "\n");
    return { lines, started };
  };
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `bun test apps/agent && bun run typecheck`
Expected: every test passes (5 new), and the typecheck is clean. The two timeout tests finish in well under a second each.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/host/console.ts apps/agent/src/packs/boot.ts apps/agent/test/host-fakes.ts apps/agent/test/boot.test.ts
git commit -m "feat(agent): boot the scratch server for pack checks, with timeouts and logs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5"
```

---

### Task 7: `mc-host profile check-packs`

**Files:**
- Create: `apps/agent/src/packs/command.ts`
- Modify: `apps/agent/src/cli.ts` (`Command`, options, parsing, `USAGE`), `apps/agent/src/commands.ts` (`runCommand`)
- Test: `apps/agent/test/cli.test.ts`, `apps/agent/test/check-packs-command.test.ts`

**Interfaces:**
- Consumes: `loadProfile`, `loadLock`, `Deps` from `src/commands.ts`; `javaFor` (Task 1); `indexPack` (Task 3); `checkPacks`, `formatReport` (Task 5); `createBoot` (Task 6); `buildServer`, `readMarker` from `src/server/build.ts`; `matchPacks` from `src/server/packs.ts`; `ensureEula` from `src/run/eula.ts`.
- Produces:
  - `Command` variant `{ kind: "check-packs"; name: string; packsDir: string; all: boolean; keep: boolean; profilesDir: string }`
  - `cmdCheckPacks(cmd, deps: Deps): Promise<void>`: throws a `UserError` carrying the summary when any pack fails

- [ ] **Step 1: Write the failing tests**

In `apps/agent/test/cli.test.ts`, add to the test `"parses each profile subcommand"`:
```ts
  expect(parseCommand(["profile", "check-packs", "adventure", "--packs", "datapacks"])).toEqual({
    kind: "check-packs", name: "adventure", packsDir: "datapacks", all: false, keep: false, profilesDir: "profiles",
  });
  expect(parseCommand(["profile", "check-packs", "a", "--packs", "d", "--all", "--keep"])).toMatchObject({ all: true, keep: true });
```
and to `"plain-English errors for missing args, unknown commands and flags"`:
```ts
  expect(() => parseCommand(["profile", "check-packs", "adventure"])).toThrow(/Missing --packs <folder>/);
```

Create `apps/agent/test/check-packs-command.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { parseProfile, profileHash, serializeLock } from "@mc/profile";
import { runCommand, type Deps } from "../src/commands";

const enc = (s: string) => new TextEncoder().encode(s);
const GOOD = "good pack v1.0 (MC 26.2).zip";
const BAD = "bad pack v1.0 (MC 26.2).zip";

/** A fake java that behaves like 26.3 with a pack whose loot table points at a missing one. */
const JAVA = [
  "#!/bin/sh",
  `if [ "$1" = "-version" ]; then echo 'openjdk version "25.0.4" 2026-07-21' >&2; exit 0; fi`,
  `echo "[10:00:00] [Worker-Main-1/ERROR]: No key layers in MapLike[{}]"`,
  "if ls check/datapacks | grep -q '^bad'; then",
  `  echo "[10:00:01] [Worker-Main-2/ERROR]: Registry loading errors:"`,
  `  echo "java.lang.IllegalStateException: Unbound values in registry ResourceKey[minecraft:root / minecraft:loot_table]: [ghost:entities/player]"`,
  `  echo "[10:00:01] [main/WARN]: Failed to load datapacks, can't proceed with server load. You can either fix your datapacks or reset to vanilla with --safeMode"`,
  "  exit 1",
  "fi",
  `echo '[10:00:02] [Server thread/INFO]: Done (1.0s)! For help, type "help"'`,
  "read line",
].join("\n");

let dir: string;
let packsDir: string;
let scratch: string;
let lines: string[];
let deps: Deps;

/** A profile plus a matching lockfile with no mod files, so the build only fetches the launcher. */
async function writeProfile(datapacks: string[]) {
  const raw = {
    name: "test",
    description: "t",
    minecraft: "26.3",
    loader: { fabric: "latest-stable" },
    memory: { min: "1G", max: "1G" },
    mods: [{ modrinth: "lithium", side: "server" }],
    datapacks,
  };
  writeFileSync(join(dir, "test.json"), JSON.stringify(raw, null, 2));
  const profile = parseProfile(raw, "test.json");
  writeFileSync(
    join(dir, "test.lock.json"),
    serializeLock({
      lockfileVersion: 1,
      profile: "test",
      profileHash: await profileHash(profile),
      minecraft: "26.3",
      javaMajor: 25,
      fabricLoader: "0.19.5",
      fabricInstaller: "1.1.2",
      files: [],
    }),
  );
}

const check = (o: { all?: boolean; keep?: boolean } = {}) =>
  runCommand({ kind: "check-packs", name: "test", packsDir, all: o.all ?? false, keep: o.keep ?? false, profilesDir: dir }, deps);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-checkcmd-"));
  packsDir = join(dir, "packs");
  scratch = join(dir, "cache", "check-packs", "test");
  lines = [];
  mkdirSync(packsDir);
  writeFileSync(join(packsDir, GOOD), zipSync({ "pack.mcmeta": enc("{}"), "data/good/function/hi.mcfunction": enc("say hi") }, { level: 0 }));
  writeFileSync(join(packsDir, BAD), zipSync({ "pack.mcmeta": enc("{}"), "data/bad/loot_table/x.json": enc('{"value":"ghost:entities/player"}') }, { level: 0 }));
  writeFileSync(join(packsDir, "notes.txt"), "not a pack");
  writeFileSync(join(dir, "java"), JAVA + "\n");
  chmodSync(join(dir, "java"), 0o755);
  deps = {
    fetch: async (url) => (url.endsWith("/server/jar") ? new Response("launcher") : new Response("no", { status: 404 })),
    cacheDir: join(dir, "cache"),
    configDir: join(dir, "config"),
    log: (l) => void lines.push(l),
    ask: async () => "yes",
    javaBin: join(dir, "java"),
  };
  await writeProfile(["vt:good-pack"]);
});

// Review focus 2
test("--all fails the pack that breaks the server, passes the rest and cleans up", async () => {
  await expect(check({ all: true })).rejects.toThrow("1 of 2 datapacks have errors (3 boots).");
  const out = lines.join("\n");
  expect(out).toContain("Checking 2 datapacks against test (Minecraft 26.3)…");
  expect(out).toContain(`  FAIL  ${BAD}\n        java.lang.IllegalStateException: Unbound values in registry`);
  expect(out).toContain(`  ok    ${GOOD}`);
  expect(existsSync(join(scratch, "check"))).toBe(false);
  expect(existsSync(join(scratch, "check-logs"))).toBe(false);
  expect(existsSync(join(scratch, "fabric-server-launch.jar"))).toBe(true);
});

test("without --all only the profile's datapacks are checked", async () => {
  await check();
  expect(lines).toContain("Checking 1 datapacks against test (Minecraft 26.3)…");
  expect(lines.at(-1)).toBe("The datapack loaded without errors (2 boots).");
});

test("--keep keeps the test world and one log per boot", async () => {
  await expect(check({ all: true, keep: true })).rejects.toThrow("have errors");
  expect(readdirSync(join(scratch, "check-logs"))).toEqual(["01-baseline.log", "02-all.log", "03-all.log"]);
  expect(existsSync(join(scratch, "check", "datapacks", GOOD))).toBe(true);
  expect(lines).toContain(`The test world and the boot logs are in ${scratch}.`);
});

test("a profile without datapacks needs --all, and missing zips are named", async () => {
  await writeProfile([]);
  await expect(check()).rejects.toThrow(`test has no datapacks. Add --all to check every zip in ${packsDir}.`);
  await writeProfile(["vt:gone"]);
  await expect(check()).rejects.toThrow(`These datapacks aren't in ${packsDir}: vt:gone.`);
});

test("declining the EULA stops before anything is built", async () => {
  deps.ask = async () => "no";
  await expect(check({ all: true })).rejects.toThrow("You need to agree to the EULA to check datapacks.");
  expect(existsSync(join(scratch, "fabric-server-launch.jar"))).toBe(false);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `bun test apps/agent/test/cli.test.ts apps/agent/test/check-packs-command.test.ts`
Expected: FAIL. `parseCommand` throws `Unknown command "profile check-packs"`, and `runCommand` has no `check-packs` case.

- [ ] **Step 3: Implement the command**

Create `apps/agent/src/packs/command.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { USER_AGENT, UserError } from "@mc/profile";
import type { Command } from "../cli";
import { loadLock, loadProfile, type Deps } from "../commands";
import { javaFor } from "../java/runtime";
import { ensureEula } from "../run/eula";
import { buildServer, readMarker } from "../server/build";
import { matchPacks } from "../server/packs";
import { createBoot } from "./boot";
import { checkPacks, formatReport } from "./check";
import { indexPack } from "./index";

const LEVEL = "check";

export async function cmdCheckPacks(cmd: Extract<Command, { kind: "check-packs" }>, deps: Deps): Promise<void> {
  const { profile } = await loadProfile(cmd.profilesDir, cmd.name);
  const lock = await loadLock(cmd.profilesDir, cmd.name, profile);
  const files = await packFiles(cmd, profile.datapacks);
  const packs = await Promise.all(files.map((f) => indexPack(cmd.packsDir, f)));

  const dir = join(deps.cacheDir, "check-packs", profile.name);
  await mkdir(dir, { recursive: true });
  if (!(await ensureEula({ configDir: deps.configDir, serverDir: dir, ask: deps.ask, log: deps.log }))) {
    throw new UserError("You need to agree to the EULA to check datapacks.");
  }
  deps.log(`Checking ${files.length} datapacks against ${profile.name} (Minecraft ${lock.minecraft})…`);
  // The server files stay between checks; only the world is thrown away.
  await buildServer({
    profile: { ...profile, datapacks: [], properties: { ...profile.properties, "level-name": LEVEL, "level-type": "minecraft:flat" } },
    lock,
    dir,
    force: true,
    fetch: deps.fetch,
    cacheDir: deps.cacheDir,
    userAgent: USER_AGENT,
  });
  const javaBin = await javaFor(lock, { cacheDir: deps.cacheDir, fetch: deps.fetch, userAgent: USER_AGENT, log: deps.log, override: deps.javaBin });
  const logsDir = join(dir, "check-logs");
  await rm(logsDir, { recursive: true, force: true });
  const boot = createBoot({ serverDir: dir, levelName: LEVEL, packsDir: cmd.packsDir, javaBin, marker: await readMarker(dir), logsDir });

  try {
    const { lines, summary, ok } = formatReport(await checkPacks(packs, boot, deps.log));
    for (const line of lines) deps.log(line);
    if (cmd.keep) deps.log(`The test world and the boot logs are in ${dir}.`);
    if (!ok) throw new UserError(summary);
    deps.log(summary);
  } finally {
    if (!cmd.keep) {
      await rm(join(dir, LEVEL), { recursive: true, force: true });
      await rm(logsDir, { recursive: true, force: true });
    }
  }
}

async function packFiles(cmd: Extract<Command, { kind: "check-packs" }>, datapacks: string[]): Promise<string[]> {
  if (!existsSync(cmd.packsDir)) throw new UserError(`The --packs folder ${cmd.packsDir} doesn't exist. Check the path and try again.`);
  const names = await readdir(cmd.packsDir);
  if (cmd.all) {
    const zips = names.filter((n) => n.toLowerCase().endsWith(".zip")).sort();
    if (!zips.length) throw new UserError(`There are no .zip files in ${cmd.packsDir}.`);
    return zips;
  }
  if (!datapacks.length) throw new UserError(`${cmd.name} has no datapacks. Add --all to check every zip in ${cmd.packsDir}.`);
  const { found, missing } = matchPacks(datapacks, names);
  if (missing.length) {
    throw new UserError(`These datapacks aren't in ${cmd.packsDir}: ${missing.join(", ")}. Add their zips, or remove them from the profile.`);
  }
  return [...found.values()].sort();
}
```

- [ ] **Step 4: Wire up the CLI**

`apps/agent/src/cli.ts`:
- Add to the `Command` union after `build-mrpack`:
  ```ts
  | { kind: "check-packs"; name: string; packsDir: string; all: boolean; keep: boolean; profilesDir: string }
  ```
- Add to `parseArgs` options: `all: { type: "boolean", default: false },` and `keep: { type: "boolean", default: false },`
- Add a case after `"build-mrpack"` in the `profile` switch:
  ```ts
        case "check-packs":
          return {
            kind: "check-packs",
            name: need(a, "<profile>"),
            packsDir: need(values.packs, "--packs <folder>"),
            all: values.all ?? false,
            keep: values.keep ?? false,
            profilesDir,
          };
  ```
- Add to `USAGE` after the `profile run <dir>` entry:
  ```
    profile check-packs <profile> --packs <folder> [--all] [--keep]
        Boot a test server with the datapacks and name the ones with errors.
        --all          check every zip in <folder>, not just the profile's datapacks
        --keep         keep the test world and the boot logs
  ```

`apps/agent/src/commands.ts`: add `import { cmdCheckPacks } from "./packs/command";`, and in `runCommand` add after the `"build-mrpack"` case:
```ts
    case "check-packs":
      return cmdCheckPacks(cmd, deps);
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `bun test apps/agent && bun run typecheck`
Expected: every test passes, and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/packs/command.ts apps/agent/src/cli.ts apps/agent/src/commands.ts apps/agent/test/cli.test.ts apps/agent/test/check-packs-command.test.ts
git commit -m "feat(agent): mc-host profile check-packs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5"
```

---

### Task 8: Docs, ROADMAP and acceptance runs

**Files:**
- Modify: `docs/setup/phase-2.md` (new section 6, checklist items), `ROADMAP.md` (the Phase 2b section)

- [ ] **Step 1: Update `ROADMAP.md`**

Replace the Phase 2b section with:
```markdown
## Phase 2b: Java and pack checks
Design: [docs/superpowers/specs/2026-09-26-phase-2b-java-and-packs-design.md](docs/superpowers/specs/2026-09-26-phase-2b-java-and-packs-design.md)
- [ ] Managed Temurin JRE on every host, Docker included (`MC_JAVA` overrides it)
- [ ] `mc-host profile check-packs`: boot a test server and name the datapacks with errors
- [ ] 2a leftovers: autosave rev bump, fresh `--replace` world with Chunky
```

- [ ] **Step 2: Update `docs/setup/phase-2.md`**

Insert before `## Manual checklist`:
````markdown
## 6. Phase 2b: Java and datapacks

mc-host downloads the Java each world needs (a Temurin JRE from Adoptium, about 58 MB) the
first time it's needed. It lands in `/data/cache/mc-host/java/` in Docker and in
`~/.cache/mc-host/java/` natively, so no host needs Java installed. To use your own Java
instead, set `MC_JAVA=/path/to/bin/java`.

After pulling this change, run `scripts/install.sh` again with the same arguments, so the
image is rebuilt without its built-in Java.

### Checking datapacks

```bash
mc-host profile check-packs adventure --packs datapacks --all
```

This builds a test server for the profile in `~/.cache/mc-host/check-packs/adventure/`,
boots it once without datapacks (the mods' own errors are ignored from then on), then with
the packs, and names every pack that causes an error. It takes about 20–60 seconds per
boot. Without `--all`, it checks only the profile's `datapacks`. Add `--keep` to look at the
test world and the boot logs afterwards.
````

Add to the end of `## Manual checklist`:
```markdown
- [ ] **2b:** after re-running `install.sh`, `docker run --rm --entrypoint sh mc-host:local -c 'command -v java || echo no-java'` prints `no-java`.
- [ ] **2b:** `mc-host start` from an empty Java cache prints "Downloading Java 25 (… MB)…" before "Claimed", and hosting works as before. A second start doesn't download again.
- [ ] **2b:** `mc-host profile check-packs adventure --packs datapacks --all` fails exactly `player head drops` and `double shulker shells`, and passes the other eight.
- [ ] **2b:** `mc-host profile check-packs adventure --packs datapacks --all --keep` leaves `check-logs/` with one log per boot.
```

- [ ] **Step 3: Run the full suite**

Run: `bun run test && bun run typecheck`
Expected: every agent and worker test passes, and the typecheck is clean.

- [ ] **Step 4: Commit**

```bash
git add ROADMAP.md docs/setup/phase-2.md
git commit -m "docs: phase 2b setup notes and checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MazMsLSJzGorDprFzJn2d5"
```

- [ ] **Step 5: Acceptance runs (with the maintainer)**

These need the real server, Docker and the Worker, so run them together with the maintainer and tick them off in `docs/setup/phase-2.md`:
1. `bun apps/agent/src/cli.ts profile check-packs adventure --packs datapacks --all`: FAIL for `player head drops v1.1.17 (MC 26.2).zip` and `double shulker shells v1.3.17 (MC 26.2).zip`, ok for the other eight, exit code 1, 3 boots.
2. Re-run `scripts/install.sh`, then `mc-host start` twice (the first downloads Java, the second doesn't), plus the 2b image check.
3. The 2a leftovers already in the checklist: the autosave rev bump, and `admin world create vanilla-plus --replace` with Chunky pre-generation (now on the managed JRE).

When everything is ticked, mark the three ROADMAP items `[x]` and commit `docs: phase 2b done`.
