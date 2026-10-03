import { strFromU8, unzipSync } from "fflate";
import { sha1Hex, sha512Hex } from "./hash";

/** What the Worker records about an uploaded jar. */
export interface JarInfo {
  sha512: string;
  sha1: string;
  size: number;
  filename: string;
  modId: string | null;
  version: string | null;
  /** fabric.mod.json's depends.minecraft; alternatives joined with " || ". */
  minecraftRange: string | null;
  javaRange: string | null;
  /** Mod IDs it depends on, other than the ones every Fabric server has. */
  depends: string[];
}

export interface JarReport extends JarInfo {
  /** Non-empty means the jar is rejected. Each is a full sentence. */
  problems: string[];
}

export interface JarTarget {
  minecraft: string;
  javaMajor: number;
}

/** A plain file name ending in .jar; the same rule the profile schema uses. */
export const JAR_FILENAME = /^[^/\\.][^/\\]*\.jar$/;

const BUILT_IN = new Set(["fabricloader", "minecraft", "java", "fabric-api", "fabric", "fabric-api-base"]);
/** Modules that ship inside Fabric API, like "fabric-resource-loader-v0". */
const FABRIC_API_MODULE = /^fabric-.+-v\d+$/;

type Part = number | "x";

function parseVersion(v: string): Part[] | null {
  const core = v.trim().split(/[-+]/)[0]!;
  if (!/^\d+(\.(\d+|[xX*]))*$/.test(core)) return null;
  return core.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : "x"));
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The first version past the range `at` fixes: bump(26.3, 1) = 26.4. */
function bump(v: number[], at: number): number[] {
  const out = v.slice(0, at + 1);
  while (out.length < at + 1) out.push(0);
  out[at] = out[at]! + 1;
  return out;
}

function matchTerm(term: string, version: number[]): boolean | null {
  if (term === "*") return true;
  const m = /^(>=|<=|>|<|=|~|\^)?(.+)$/.exec(term);
  if (!m) return null;
  const op = m[1] ?? "=";
  const want = parseVersion(m[2]!);
  if (!want) return null;
  const wildcard = want.indexOf("x");
  if (wildcard !== -1) {
    if (op !== "=") return null;
    return (want.slice(0, wildcard) as number[]).every((n, i) => (version[i] ?? 0) === n);
  }
  const w = want as number[];
  const c = compare(version, w);
  switch (op) {
    case "=":
      return c === 0;
    case ">=":
      return c >= 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    case "~":
      return c >= 0 && compare(version, bump(w, Math.min(1, w.length - 1))) < 0;
    case "^":
      return c >= 0 && compare(version, bump(w, 0)) < 0;
  }
  return null;
}

/**
 * Whether a Fabric version range ("=26.3", ">=1.14 <=26.3.9", "~26.3", "26.3.x", "a || b")
 * includes a version. Null when the range can't be read, so callers treat it as unknown.
 */
export function rangeIncludes(range: string, version: string): boolean | null {
  const v = parseVersion(version);
  if (!v || v.includes("x")) return null;
  const results = range.split("||").map((alt) => {
    const terms = alt.trim().replace(/([<>=~^])\s+/g, "$1").split(/\s+/).filter(Boolean);
    const hits = terms.map((t) => matchTerm(t, v as number[]));
    if (hits.includes(false)) return false;
    if (hits.includes(null)) return null;
    return true;
  });
  if (results.includes(true)) return true;
  if (results.includes(null)) return null;
  return false;
}

const asRange = (v: unknown): string | null =>
  typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(" || ") : null;

/** Check a mod jar against the Minecraft and Java it will run on. Never throws for a bad jar. */
export async function inspectJar(bytes: Uint8Array, filename: string, target: JarTarget): Promise<JarReport> {
  const [sha1, sha512] = await Promise.all([sha1Hex(bytes), sha512Hex(bytes)]);
  const report: JarReport = {
    sha512,
    sha1,
    size: bytes.length,
    filename,
    modId: null,
    version: null,
    minecraftRange: null,
    javaRange: null,
    depends: [],
    problems: [],
  };
  const reject = (problem: string) => ({ ...report, problems: [problem] });
  if (!JAR_FILENAME.test(filename)) return reject(`"${filename}" must be a file name ending in ".jar".`);

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === "fabric.mod.json" || /^META-INF\/(neoforge\.)?mods\.toml$/.test(f.name) });
  } catch {
    return reject(`${filename} isn't a valid jar. Was the download finished?`);
  }
  if (bytes.length === 0) return reject(`${filename} isn't a valid jar. Was the download finished?`);
  const meta = files["fabric.mod.json"];
  if (!meta) {
    const loader = files["META-INF/neoforge.mods.toml"] ? "NeoForge" : files["META-INF/mods.toml"] ? "Forge" : null;
    return reject(
      loader
        ? `${filename} is a ${loader} build. Get the Fabric build of this mod instead.`
        : `${filename} isn't a Fabric mod (it has no fabric.mod.json).`,
    );
  }
  let json: { id?: unknown; version?: unknown; depends?: Record<string, unknown> };
  try {
    json = JSON.parse(strFromU8(meta).replace(/^﻿/, ""));
  } catch {
    return reject(`${filename} has a fabric.mod.json that isn't valid JSON.`);
  }
  const depends = json.depends && typeof json.depends === "object" ? json.depends : {};
  report.modId = typeof json.id === "string" ? json.id : null;
  report.version = typeof json.version === "string" ? json.version : null;
  report.minecraftRange = asRange(depends.minecraft);
  report.javaRange = asRange(depends.java);
  report.depends = Object.keys(depends).filter((k) => !BUILT_IN.has(k) && !FABRIC_API_MODULE.test(k)).sort();

  if (report.minecraftRange && rangeIncludes(report.minecraftRange, target.minecraft) === false) {
    report.problems.push(`${filename} is built for Minecraft ${report.minecraftRange}, but the profile is on ${target.minecraft}.`);
  }
  if (report.javaRange && rangeIncludes(report.javaRange, String(target.javaMajor)) === false) {
    report.problems.push(`${filename} needs Java ${report.javaRange}, but Minecraft ${target.minecraft} runs on Java ${target.javaMajor}.`);
  }
  return report;
}

/** The profile name for a jar: its mod ID, or its file name, in slug characters. */
export function jarName(modId: string | null, filename: string): string {
  const raw = modId ?? filename.replace(/\.jar$/i, "");
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "jar";
}

/** The line to paste into a profile's "mods", in the profile's key order. */
export function jarProfileLine(o: { name: string; filename: string; sha512: string; side: "server" | "both" }): string {
  return JSON.stringify({ jar: o.name, filename: o.filename, sha512: o.sha512, side: o.side });
}

/** `have`: names already in the profile or its lockfile, which need no hint. */
export function dependencyHints(depends: string[], have: string[] = []): string[] {
  return depends.filter((d) => !have.includes(d)).map((d) => `Needs "${d}". Add it from Modrinth if it's there, or upload its jar too.`);
}
