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
