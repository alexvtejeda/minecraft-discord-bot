# Local Jars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a profile list mod jars that aren't on Modrinth. A maintainer uploads a jar with `mc-host admin jar add` or `/mod upload`. It is checked, stored in R2 by sha512, and referenced from the profile in git. Servers download it from the Worker, and players get it inside the `.mrpack`.

**Architecture:** A pure `inspectJar` in `packages/profile` reads `fabric.mod.json` and checks the loader and the Minecraft/Java ranges. Both the Bun CLI and the Worker run it. Profiles gain a `{ jar, filename, sha512, side }` entry kind. The resolver turns it into a lock entry with `source: "jar"` and a Worker-relative `url`, using a `JarLookup` client backed by `GET /admin/jars/<sha512>`. The Worker stores jars at `jars/<sha512>.jar` plus a D1 `jars` row, serves them at `GET /jars/<sha512>` (agent token or admin secret), and bundles them into `.mrpack` `overrides/mods/`.

**Tech Stack:** Bun + TypeScript, zod 4, fflate, Hono on Cloudflare Workers (D1, R2), vitest with `@cloudflare/vitest-plugin`, Discord interactions.

**Spec:** `docs/superpowers/specs/2026-10-03-local-jars-design.md`

## Global Constraints

- Local jars only fill gaps. No CurseForge API.
- The profile in git is the source of truth. `/mod upload` never changes a world.
- R2 key: `jars/<sha512>.jar`. D1 table `jars`, keyed by sha512 (lowercase hex, 128 characters).
- `side` of a jar entry is `"server"` or `"both"` only. `clientOptional` and `version` aren't allowed on a jar entry.
- `GET /jars/<sha512>` requires a hosting token or the admin secret. Never public: the repo and lockfiles are public.
- Rejected: an invalid zip, no `fabric.mod.json`, a `minecraft` or `java` range that excludes the target. Everything else in `depends` is only a hint.
- `lockfileVersion` stays `1`. Lock entries for jars carry `source: "jar"`, `projectId: "jar"`, `versionId` = the first 12 characters of the sha512, and `url` = `jars/<sha512>`.
- Agent version becomes `0.3.0`, and the Worker's `MIN_AGENT_VERSION` becomes `"0.3.0"`.
- User-facing text follows the repo's style: full sentences, says what to do next, no exclamation marks.
- Run `bun test` (Bun tests), `bun run --cwd apps/worker test` (vitest) and `bun run typecheck` from the repo root before each commit that touches the code they cover.

## Changes from the spec (recorded in the spec in Task 10)

| Spec | Plan | Why |
|---|---|---|
| Admin upload is a presigned PUT, then a commit | One `PUT /admin/jars/<sha512>?filename=&minecraft=&java=` with the jar as the body | Jars are small (largest here: 6 MB). One request, no half-finished state. |
| Rejected checks answer 422 | `bad_request` (400) | There's no 422 in `ERROR_CODES`. |
| `/mod upload` limit 25 MB | 32 MB (`MAX_JAR_BYTES`) for both paths | One constant. Discord's own limit is lower anyway. |
| `/mod upload` falls back to the newest bundled profile | No active world means the reply points to the CLI | YAGNI. |
| `jar add --minecraft <v>` | `mc-host admin jar add <profile> <file.jar>` | The profile gives the Minecraft version, and the Mojang meta gives Java. |
| D1 columns | Adds `java_range` and `depends_json` | `GET /admin/jars` returns the same `JarInfo` that `inspectJar` produced. |
| `check-packs` reports mod-load failures | Also: `--packs` is optional, and a profile with no datapacks gets a single "mods only" boot | `cst` has no datapacks, so without this it couldn't be checked at all. |

## Review Focus

1. **A modrinth entry's mistakes must still be reported field by field** (`mods.0.side: Invalid option…`), not as a bare "Invalid input" from a zod union. This is pinned in Task 2.
2. **Existing lockfiles must stay valid.** Changing the mod schema must not change `profileHash` for Modrinth-only profiles. The bundled-profile check in `world-new.vitest.ts` and a hash test in Task 2 cover it.
3. **A jar whose filename has spaces** (`antiquetradingship-1.0.0 Fabric 26.3.jar`) must round-trip through the schema, the lock, the server build and the `.mrpack`. This is pinned in Tasks 1, 2 and 5.
4. **A jar re-uploaded for a different Minecraft version** must be checked again against the new target, not waved through because the row exists. This is pinned in Task 4.
5. **A lock with jars built locally without credentials** must fail before touching the server folder, with a message naming the env vars. This is pinned in Task 8.

---

### Task 1: `inspectJar`, version ranges and profile-line helpers

**Files:**
- Create: `packages/profile/src/jarcheck.ts`
- Modify: `packages/profile/src/hash.ts` (add `sha1Hex`)
- Modify: `packages/profile/src/index.ts` (export `./jarcheck`)
- Test: `packages/profile/test/jarcheck.test.ts`

**Interfaces:**
- Produces:
  - `sha1Hex(data: Uint8Array): Promise<string>`
  - `interface JarInfo { sha512: string; sha1: string; size: number; filename: string; modId: string | null; version: string | null; minecraftRange: string | null; javaRange: string | null; depends: string[] }`
  - `interface JarReport extends JarInfo { problems: string[] }`
  - `interface JarTarget { minecraft: string; javaMajor: number }`
  - `rangeIncludes(range: string, version: string): boolean | null`, where null means the range can't be parsed
  - `inspectJar(bytes: Uint8Array, filename: string, target: JarTarget): Promise<JarReport>`
  - `jarName(modId: string | null, filename: string): string`
  - `jarProfileLine(o: { name: string; filename: string; sha512: string; side: "server" | "both" }): string`
  - `dependencyHints(depends: string[]): string[]`
  - `JAR_FILENAME: RegExp`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/profile/test/jarcheck.test.ts
import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { sha512Hex } from "../src/hash";
import { dependencyHints, inspectJar, jarName, jarProfileLine, rangeIncludes } from "../src/jarcheck";

const jar = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const fabric = (o: Record<string, unknown> = {}) =>
  jar({ "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "dragonbond", version: "1.1.1", ...o }) });
const T = { minecraft: "26.3", javaMajor: 25 };

describe("rangeIncludes", () => {
  test.each([
    ["*", "26.3", true],
    ["", "26.3", true],
    ["26.3", "26.3", true],
    ["=26.3", "26.3.0", true],
    ["=26.1.2", "26.3", false],
    [">=26.3", "26.3", true],
    [">26.3", "26.3", false],
    ["<26.4", "26.3", true],
    ["<=26.2", "26.3", false],
    ["~26.3", "26.3.5", true],
    ["~26.3", "26.4", false],
    ["^26.3", "26.9", true],
    ["^26.3", "27.0", false],
    [">=1.14 <=26.3.9", "26.3", true],
    [">= 1.14 <= 26.2", "26.3", false],
    ["26.3.x", "26.3.7", true],
    ["26.2.x", "26.3", false],
    ["=26.1 || =26.3", "26.3", true],
    [">=25", "25", true],
    [">=21", "17", false],
  ])("%p includes %p → %p", (range, version, want) => {
    expect(rangeIncludes(range, version)).toBe(want);
  });

  test("is null when the range can't be read", () => {
    expect(rangeIncludes("26.3-alpha.foo bar!", "26.3")).toBeNull();
    expect(rangeIncludes("@latest", "26.3")).toBeNull();
  });

  test("a false term wins over an unreadable one", () => {
    expect(rangeIncludes("=26.1 @x", "26.3")).toBe(false);
  });
});

describe("inspectJar", () => {
  test("reads id, version, ranges and extra dependencies", async () => {
    const bytes = fabric({ depends: { fabricloader: ">=0.19.5", minecraft: "=26.3", java: ">=25", "fabric-api": "*", citadel: ">=26.3-1.0.0" } });
    const r = await inspectJar(bytes, "the-deeper-end-fabric-1.1.1.jar", T);
    expect(r).toMatchObject({
      filename: "the-deeper-end-fabric-1.1.1.jar",
      modId: "dragonbond",
      version: "1.1.1",
      minecraftRange: "=26.3",
      javaRange: ">=25",
      depends: ["citadel"],
      problems: [],
      size: bytes.length,
    });
    expect(r.sha512).toBe(await sha512Hex(bytes));
    expect(r.sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  test("keeps array ranges as alternatives", async () => {
    const r = await inspectJar(fabric({ depends: { minecraft: ["=26.1", "=26.3"] } }), "a.jar", T);
    expect(r.minecraftRange).toBe("=26.1 || =26.3");
    expect(r.problems).toEqual([]);
  });

  test("rejects a jar for another Minecraft version", async () => {
    const r = await inspectJar(fabric({ depends: { minecraft: "=26.1.2" } }), "world-bosses.jar", T);
    expect(r.problems).toEqual(["world-bosses.jar is built for Minecraft =26.1.2, but the profile is on 26.3."]);
  });

  test("rejects a jar that needs a newer Java", async () => {
    const r = await inspectJar(fabric({ depends: { java: ">=26" } }), "a.jar", T);
    expect(r.problems).toEqual(["a.jar needs Java >=26, but Minecraft 26.3 runs on Java 25."]);
  });

  test("names the loader of a NeoForge or Forge build", async () => {
    const neo = await inspectJar(jar({ "META-INF/neoforge.mods.toml": "" }), "collectall-neoforge.jar", T);
    expect(neo.problems).toEqual(["collectall-neoforge.jar is a NeoForge build. Get the Fabric build of this mod instead."]);
    const forge = await inspectJar(jar({ "META-INF/mods.toml": "" }), "BiomesOPlenty-forge.jar", T);
    expect(forge.problems[0]).toContain("is a Forge build");
    const other = await inspectJar(jar({ "readme.txt": "" }), "x.jar", T);
    expect(other.problems).toEqual(["x.jar isn't a Fabric mod (it has no fabric.mod.json)."]);
  });

  test("rejects an empty or truncated file", async () => {
    const r = await inspectJar(new Uint8Array(0), "ClickMobs.jar", T);
    expect(r.problems).toEqual(["ClickMobs.jar isn't a valid jar. Was the download finished?"]);
    const cut = await inspectJar(fabric().slice(0, 40), "cut.jar", T);
    expect(cut.problems[0]).toContain("isn't a valid jar");
  });

  test("rejects a bad fabric.mod.json and a bad file name", async () => {
    expect((await inspectJar(jar({ "fabric.mod.json": "{nope" }), "a.jar", T)).problems).toEqual([
      "a.jar has a fabric.mod.json that isn't valid JSON.",
    ]);
    expect((await inspectJar(fabric(), "a.zip", T)).problems).toEqual(['"a.zip" must be a file name ending in ".jar".']);
    expect((await inspectJar(fabric(), "../a.jar", T)).problems[0]).toContain("must be a file name");
  });

  test("accepts a name with spaces", async () => {
    expect((await inspectJar(fabric(), "antiquetradingship-1.0.0 Fabric 26.3.jar", T)).problems).toEqual([]);
  });

  test("an unreadable range is not a problem", async () => {
    expect((await inspectJar(fabric({ depends: { minecraft: "@latest" } }), "a.jar", T)).problems).toEqual([]);
  });
});

describe("profile helpers", () => {
  test("jarName normalizes the mod ID, or falls back to the file name", () => {
    expect(jarName("dragonbond", "x.jar")).toBe("dragonbond");
    expect(jarName("Alex_Mobs", "x.jar")).toBe("alex_mobs");
    expect(jarName(null, "Strucutres v4.2.jar")).toBe("strucutres-v4.2");
  });

  test("jarProfileLine is one line of JSON in profile key order", () => {
    expect(jarProfileLine({ name: "dragonbond", filename: "a b.jar", sha512: "f".repeat(128), side: "both" })).toBe(
      `{"jar":"dragonbond","filename":"a b.jar","sha512":"${"f".repeat(128)}","side":"both"}`,
    );
  });

  test("dependencyHints names each dependency", () => {
    expect(dependencyHints(["citadel"])).toEqual([
      'Needs "citadel". Add it from Modrinth if it\'s there, or upload its jar too.',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test packages/profile/test/jarcheck.test.ts`
Expected: FAIL with `Cannot find module '../src/jarcheck'`.

- [ ] **Step 3: Add `sha1Hex` to `packages/profile/src/hash.ts`**

Add this below `sha512Hex`:

```ts
export async function sha1Hex(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", new Uint8Array(data)));
}
```

- [ ] **Step 4: Write `packages/profile/src/jarcheck.ts`**

```ts
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

const BUILT_IN = new Set(["fabricloader", "minecraft", "java", "fabric-api", "fabric"]);

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
  report.depends = Object.keys(depends).filter((k) => !BUILT_IN.has(k)).sort();

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

export function dependencyHints(depends: string[]): string[] {
  return depends.map((d) => `Needs "${d}". Add it from Modrinth if it's there, or upload its jar too.`);
}
```

Note: `unzipSync` on zero bytes may return `{}` instead of throwing, which is why the empty check comes after the `try`.

- [ ] **Step 5: Export it**

In `packages/profile/src/index.ts`, add `export * from "./jarcheck";` after `export * from "./mrpack";`.

- [ ] **Step 6: Run the tests and see them pass**

Run: `bun test packages/profile/test/jarcheck.test.ts`
Expected: PASS. If a `rangeIncludes` row fails, fix the implementation, not the table. The table is the spec.

- [ ] **Step 7: Commit**

```bash
git add packages/profile/src/jarcheck.ts packages/profile/src/hash.ts packages/profile/src/index.ts packages/profile/test/jarcheck.test.ts
git commit -m "feat(profile): inspectJar checks a mod jar's loader and Minecraft/Java ranges"
```

---

### Task 2: Jar entries in the profile schema

**Files:**
- Modify: `packages/profile/src/schema.ts`
- Modify: `packages/profile/src/resolve.ts` (only the two places that read `m.modrinth`)
- Test: `packages/profile/test/schema.test.ts`

**Interfaces:**
- Consumes: `JAR_FILENAME` from Task 1.
- Produces:
  - `JAR_SIDES = ["server", "both"] as const`, and `type JarSide`
  - `type ModrinthEntry`, `type JarEntry`, `type ModEntry = ModrinthEntry | JarEntry`
  - `isJarEntry(m: ModEntry): m is JarEntry`
  - `isModrinthEntry(m: ModEntry): m is ModrinthEntry`
  - `modName(m: ModEntry): string`

- [ ] **Step 1: Write the failing tests** (append to `packages/profile/test/schema.test.ts`, inside or after the existing `describe`)

```ts
import { isJarEntry, modName } from "../src/schema";
import { profileHash } from "../src/lockfile";

const SHA = "a".repeat(128);
const jarEntry = { jar: "dragonbond", filename: "the-deeper-end-fabric-1.1.1.jar", sha512: SHA, side: "both" };

describe("jar entries", () => {
  test("parse next to modrinth entries", () => {
    const p = parseProfile({ ...base, mods: [...base.mods, jarEntry] }, "test.json");
    expect(p.mods.map(modName)).toEqual(["lithium", "dragonbond"]);
    expect(isJarEntry(p.mods[1]!)).toBe(true);
  });

  test("accept a file name with spaces", () => {
    const e = { ...jarEntry, filename: "antiquetradingship-1.0.0 Fabric 26.3.jar" };
    expect(() => parseProfile({ ...base, mods: [e] }, "test.json")).not.toThrow();
  });

  test("report jar mistakes against the jar's own fields", () => {
    const bad = { ...base, mods: [{ ...jarEntry, side: "client-optional" }] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/mods\.0\.side: must be "server" or "both"/);
    expect(() => parseProfile({ ...base, mods: [{ ...jarEntry, sha512: "abc" }] }, "test.json")).toThrow(/mods\.0\.sha512/);
    expect(() => parseProfile({ ...base, mods: [{ ...jarEntry, filename: "../x.jar" }] }, "test.json")).toThrow(/mods\.0\.filename/);
    expect(() => parseProfile({ ...base, mods: [{ ...jarEntry, clientOptional: true }] }, "test.json")).toThrow(/Unrecognized key/);
  });

  // Review focus 1: the per-key schema keeps modrinth errors precise.
  test("a modrinth entry's bad side still names mods.0.side", () => {
    const bad = { ...base, mods: [{ modrinth: "lithium", side: "client" }] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/mods\.0\.side/);
  });

  test("names are unique across modrinth, jar and waiting", () => {
    const dup = { ...base, mods: [...base.mods, { ...jarEntry, jar: "lithium" }] };
    expect(() => parseProfile(dup, "test.json")).toThrow(/"lithium" is listed twice/);
    expect(() => parseProfile({ ...base, mods: [jarEntry], waiting: ["dragonbond"] }, "test.json")).toThrow(/both "mods" and "waiting"/);
  });

  // Review focus 2: existing lockfiles keep matching.
  test("a modrinth-only profile hashes the same as before the union", async () => {
    const p = parseProfile({ ...base, mods: [{ modrinth: "lithium", side: "both", clientOptional: true, version: "x" }] }, "t.json");
    expect(JSON.stringify(p.mods[0])).toBe('{"modrinth":"lithium","side":"both","clientOptional":true,"version":"x"}');
    expect(await profileHash(p)).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test packages/profile/test/schema.test.ts`
Expected: FAIL. `isJarEntry` isn't exported, and the jar entries are rejected as unknown keys.

- [ ] **Step 3: Change `packages/profile/src/schema.ts`**

Replace the `ModEntrySchema` declaration with the following. The `import { JAR_FILENAME } from "./jarcheck";` goes at the top.

```ts
export const JAR_SIDES = ["server", "both"] as const;
export type JarSide = (typeof JAR_SIDES)[number];

const ModrinthEntrySchema = z.strictObject({
  modrinth: slug,
  side: z.enum(SIDES),
  clientOptional: z.boolean().optional(),
  version: z.string().min(1).optional(),
});

const JarEntrySchema = z.strictObject({
  jar: z.string().regex(/^[a-z0-9._-]+$/, 'must be lowercase letters, digits, ".", "_" and "-"'),
  filename: z.string().regex(JAR_FILENAME, 'must be a file name ending in ".jar", like "mymod-1.0.jar"'),
  sha512: z.string().regex(/^[0-9a-f]{128}$/, "must be the 128-character sha512 that mc-host admin jar add printed"),
  side: z.enum(JAR_SIDES, { error: `must be "server" or "both": players can't opt out of an uploaded jar` }),
});

export type ModrinthEntry = z.infer<typeof ModrinthEntrySchema>;
export type JarEntry = z.infer<typeof JarEntrySchema>;

/**
 * Picks the schema by key, so mistakes are reported against the right fields. A plain
 * z.union would report every mistake as "Invalid input" on the whole entry.
 */
const ModEntrySchema = z.unknown().transform((v, ctx): ModrinthEntry | JarEntry => {
  const schema = v !== null && typeof v === "object" && "jar" in v ? JarEntrySchema : ModrinthEntrySchema;
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  for (const i of r.error.issues) ctx.addIssue({ code: "custom", path: i.path, message: i.message });
  return z.NEVER;
});

export const isJarEntry = (m: ModrinthEntry | JarEntry): m is JarEntry => "jar" in m;
export const isModrinthEntry = (m: ModrinthEntry | JarEntry): m is ModrinthEntry => !isJarEntry(m);
export const modName = (m: ModrinthEntry | JarEntry): string => (isJarEntry(m) ? m.jar : m.modrinth);
```

In `superRefine`, replace the `p.mods.forEach` body with:

```ts
    p.mods.forEach((m, i) => {
      const name = modName(m);
      if (seen.has(name)) {
        ctx.addIssue({ code: "custom", path: ["mods", i, isJarEntry(m) ? "jar" : "modrinth"], message: `"${name}" is listed twice` });
      }
      seen.add(name);
      if (isModrinthEntry(m) && m.clientOptional !== undefined && m.side !== "both") {
        ctx.addIssue({ code: "custom", path: ["mods", i, "clientOptional"], message: 'only works with side "both"' });
      }
    });
```

`export type ModEntry = Profile["mods"][number];` stays as it is. It is now the union.

- [ ] **Step 4: Update the two readers in `packages/profile/src/resolve.ts`**

Import `isModrinthEntry` from `./schema`. In `resolveProfile`:

```ts
  const queue: Job[] = profile.mods.filter(isModrinthEntry).map((m) => ({
```

In `checkAvailability` (uploaded jars aren't on Modrinth, so there's nothing to check):

```ts
    ...profile.mods.filter(isModrinthEntry).map((m) => ({ slug: m.modrinth, waiting: false })),
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/profile && bun run typecheck`
Expected: PASS. Typecheck may flag other `m.modrinth` readers. The grep in this plan found none outside `resolve.ts` and `schema.ts`, so fix any that do appear with `isModrinthEntry`.

- [ ] **Step 6: Run the Worker tests (bundled profiles must still match their locks)**

Run: `bun run --cwd apps/worker test`
Expected: PASS, including the bundled-profile check in `world-new.vitest.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/profile/src/schema.ts packages/profile/src/resolve.ts packages/profile/test/schema.test.ts
git commit -m "feat(profile): jar entries in profiles"
```

---

### Task 3: Lock entries for jars, resolving them, and leaving them out of the `.mrpack` index

**Files:**
- Modify: `packages/profile/src/lockfile.ts`
- Modify: `packages/profile/src/resolve.ts`
- Modify: `packages/profile/src/mrpack.ts`
- Modify: `packages/profile/test/fakes.ts` (add `FakeJars`)
- Test: `packages/profile/test/resolve.test.ts`, `packages/profile/test/mrpack.test.ts`

**Interfaces:**
- Consumes: `JarInfo`, `rangeIncludes` (Task 1). `JarEntry`, `isJarEntry` (Task 2).
- Produces:
  - `LockEntry.source?: "jar"`
  - `jarUrl(sha512: string): string`, which returns `jars/<sha512>`
  - `jarLockEntry(j: JarEntry, info: JarInfo): LockEntry`
  - `isUploadedJar(f: LockEntry): boolean`
  - `interface JarLookup { lookup(sha512: string): Promise<JarInfo | null> }`
  - `ResolveDeps.jars?: JarLookup`

- [ ] **Step 1: Add `FakeJars` to `packages/profile/test/fakes.ts`**

```ts
import type { JarInfo } from "../src/jarcheck";
import type { JarLookup } from "../src/resolve";

export function jarInfo(sha512: string, over: Partial<JarInfo> = {}): JarInfo {
  return {
    sha512,
    sha1: "1".repeat(40),
    size: 1234,
    filename: "uploaded.jar",
    modId: "dragonbond",
    version: "1.1.1",
    minecraftRange: "=26.3",
    javaRange: ">=25",
    depends: [],
    ...over,
  };
}

/** Uploaded jars by sha512. */
export class FakeJars implements JarLookup {
  rows = new Map<string, JarInfo>();
  add(info: JarInfo) {
    this.rows.set(info.sha512, info);
  }
  async lookup(sha512: string) {
    return this.rows.get(sha512) ?? null;
  }
}
```

- [ ] **Step 2: Write the failing resolve tests** (append to `packages/profile/test/resolve.test.ts`)

```ts
import { FakeJars, jarInfo } from "./fakes";

describe("uploaded jars", () => {
  const SHA = "b".repeat(128);
  const entry = { jar: "dragonbond", filename: "the deeper end.jar", sha512: SHA, side: "both" };

  test("become lock entries with source jar, sorted with the rest", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium");
    const jars = new FakeJars();
    jars.add(jarInfo(SHA));
    const profile = makeProfile({ mods: [{ modrinth: "lithium", side: "server" }, entry] });
    const { lock } = await resolveProfile(profile, { ...deps(mr), jars });
    expect(lock.files.map((f) => f.slug)).toEqual(["dragonbond", "lithium"]);
    expect(lock.files[0]).toEqual({
      slug: "dragonbond",
      projectId: "jar",
      versionId: SHA.slice(0, 12),
      versionNumber: "1.1.1",
      filename: "the deeper end.jar",
      url: `jars/${SHA}`,
      sha1: "1".repeat(40),
      sha512: SHA,
      size: 1234,
      side: "both",
      clientOptional: false,
      auto: false,
      prerelease: false,
      source: "jar",
    });
    expect(parseLock(serializeLock(lock), "x").files[0]!.source).toBe("jar");
  });

  test("fail when the jar was never uploaded", async () => {
    const profile = makeProfile({ mods: [entry] });
    await expect(resolveProfile(profile, { ...deps(new FakeModrinth()), jars: new FakeJars() })).rejects.toThrow(
      `dragonbond: sha512 ${SHA.slice(0, 12)} isn't uploaded. Run "mc-host admin jar add test the deeper end.jar".`,
    );
  });

  test("fail without a jar client", async () => {
    await expect(resolveProfile(makeProfile({ mods: [entry] }), deps(new FakeModrinth()))).rejects.toThrow(/MC_WORKER_URL and MC_ADMIN_SECRET/);
  });

  test("fail when the jar is for another Minecraft version", async () => {
    const jars = new FakeJars();
    jars.add(jarInfo(SHA, { minecraftRange: "=26.1.2" }));
    await expect(resolveProfile(makeProfile({ mods: [entry] }), { ...deps(new FakeModrinth()), jars })).rejects.toThrow(
      "dragonbond is built for Minecraft =26.1.2, but test is on 26.3. Remove it from the profile.",
    );
  });

  test("a jar can't share a name with a Modrinth file", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium");
    const jars = new FakeJars();
    jars.add(jarInfo(SHA));
    const profile = makeProfile({ mods: [{ modrinth: "lithium", side: "server" }, { ...entry, jar: "x" }] });
    // Same name via a dependency: lithium pulls in "x".
    mr.add("x");
    mr.versions.get("LITHIUM")![0]!.dependencies = [dep("X")];
    await expect(resolveProfile(profile, { ...deps(mr), jars })).rejects.toThrow(/"x" is also the name of a mod from Modrinth/);
  });

  test("warn when the jar's mod ID matches a Modrinth slug", async () => {
    const mr = new FakeModrinth();
    mr.add("dragonbond-mr");
    const jars = new FakeJars();
    jars.add(jarInfo(SHA, { modId: "dragonbond-mr" }));
    const profile = makeProfile({ mods: [{ modrinth: "dragonbond-mr", side: "both" }, entry] });
    const { warnings } = await resolveProfile(profile, { ...deps(mr), jars });
    expect(warnings).toContain('dragonbond may be the same mod as Modrinth\'s "dragonbond-mr". Remove one of them if the server fails to start.');
  });
});
```

- [ ] **Step 3: Write the failing mrpack test** (append to `packages/profile/test/mrpack.test.ts`)

```ts
test("uploaded jars stay out of files[] and ride in overrides", async () => {
  const jar: LockEntry = { ...entry("dragonbond", "both"), filename: "a b.jar", url: `jars/${"c".repeat(128)}`, projectId: "jar", source: "jar" };
  const withJar: Lockfile = { ...lock, files: [entry("waystones", "both"), jar] };
  const index = await mrpackIndex(withJar, { name: "t" });
  expect(index.files.map((f) => f.path)).toEqual(["mods/waystones.jar"]);
  const extras = [{ path: "mods/a b.jar", data: new Uint8Array([1, 2]) }];
  const bytes = await buildMrpack(withJar, { name: "t" }, extras);
  expect(unzipSync(bytes)["overrides/mods/a b.jar"]).toEqual(new Uint8Array([1, 2]));
  expect(await buildMrpack(withJar, { name: "t" }, extras)).toEqual(bytes);
});
```

(`entry` and `lock` are the helpers already at the top of `mrpack.test.ts`.)

- [ ] **Step 4: Run them and watch them fail**

Run: `bun test packages/profile/test/resolve.test.ts packages/profile/test/mrpack.test.ts`
Expected: FAIL. `jars` is ignored, and the jar shows up in `files[]`.

- [ ] **Step 5: `lockfile.ts`: add the field and helpers**

In `LockEntry`, after `prerelease`:

```ts
  /** "jar": uploaded to the Worker rather than from Modrinth; url is then relative to the Worker. */
  source?: "jar";
```

Below `profileHash`:

```ts
export const jarUrl = (sha512: string): string => `jars/${sha512}`;

export const isUploadedJar = (f: LockEntry): boolean => f.source === "jar";

export function jarLockEntry(j: JarEntry, info: JarInfo): LockEntry {
  return {
    slug: j.jar,
    projectId: "jar",
    versionId: j.sha512.slice(0, 12),
    versionNumber: info.version ?? "unknown",
    filename: j.filename,
    url: jarUrl(j.sha512),
    sha1: info.sha1,
    sha512: j.sha512,
    size: info.size,
    side: j.side,
    clientOptional: false,
    auto: false,
    prerelease: false,
    source: "jar",
  };
}
```

Imports: `import type { JarInfo } from "./jarcheck";` and add `JarEntry` to the type import from `./schema`.

- [ ] **Step 6: `resolve.ts`: look up jars**

Add to the imports: `isJarEntry` from `./schema`, `jarLockEntry` from `./lockfile`, and `rangeIncludes, type JarInfo` from `./jarcheck`.

```ts
export interface JarLookup {
  lookup(sha512: string): Promise<JarInfo | null>;
}

export interface ResolveDeps {
  modrinth: ModrinthClient;
  fabric: FabricMeta;
  mojang: MojangMeta;
  /** Uploaded jars. Only needed when the profile lists some. */
  jars?: JarLookup;
}
```

In `resolveProfile`, drop the `.sort(...)` from the `files` expression (keep the `.map`), then add the following before `const waiting = ...`:

```ts
  const fromModrinth = new Set(files.map((f) => f.slug));
  const jarEntries = profile.mods.filter(isJarEntry);
  if (jarEntries.length && !deps.jars) {
    throw new UserError(`${profile.name} has uploaded jars, so resolving it needs the Worker: set MC_WORKER_URL and MC_ADMIN_SECRET.`);
  }
  for (const j of jarEntries) {
    const info = await deps.jars!.lookup(j.sha512);
    if (!info) {
      throw new UserError(
        `${j.jar}: sha512 ${j.sha512.slice(0, 12)} isn't uploaded. Run "mc-host admin jar add ${profile.name} ${j.filename}".`,
      );
    }
    if (info.minecraftRange && rangeIncludes(info.minecraftRange, mc) === false) {
      throw new UserError(`${j.jar} is built for Minecraft ${info.minecraftRange}, but ${profile.name} is on ${mc}. Remove it from the profile.`);
    }
    if (fromModrinth.has(j.jar)) {
      throw new UserError(`"${j.jar}" is also the name of a mod from Modrinth. Give the jar entry another name.`);
    }
    if (info.modId && info.modId !== j.jar && fromModrinth.has(info.modId)) {
      warnings.push(`${j.jar} may be the same mod as Modrinth's "${info.modId}". Remove one of them if the server fails to start.`);
    }
    files.push(jarLockEntry(j, info));
  }
  files.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
```

The "fail when never uploaded" test above passes a filename with spaces, and the message quotes it unquoted. That's intended: it matches what gets typed in the shell. Don't add quoting.

- [ ] **Step 7: `mrpack.ts`: leave jars out of the index**

In `mrpackIndex`'s `flatMap`, as the first line:

```ts
    if (isUploadedJar(f)) return [];
```

Import `isUploadedJar` from `./lockfile`. Update the `ExtraFile` comment to say: `/** A file bundled inside the pack under overrides/: uploaded jars, which only the Worker has. */`

- [ ] **Step 8: Run the tests**

Run: `bun test packages/profile && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/profile
git commit -m "feat(profile): resolve uploaded jars into the lockfile"
```

---

### Task 4: Worker stores, looks up and serves jars

**Files:**
- Create: `apps/worker/migrations/0003_jars.sql`
- Create: `apps/worker/src/jars.ts`
- Create: `apps/worker/src/routes/jars.ts`
- Modify: `packages/protocol/src/index.ts` (jar schemas)
- Modify: `apps/worker/src/auth.ts` (`agentOrAdminAuth`)
- Modify: `apps/worker/src/routes/admin.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/test/jars.vitest.ts`, plus a `fabricJar` helper in `apps/worker/test/helpers.ts`

**Interfaces:**
- Consumes: `inspectJar`, `JarInfo`, `JarTarget` (Task 1).
- Produces:
  - Protocol: `Sha512Schema`, `JarInfoSchema`, `type JarInfoBody`, `JarUploadResponseSchema`, `type JarUploadResponse`
  - `apps/worker/src/jars.ts`: `MAX_JAR_BYTES`, `jarKey(sha512)`, `getJar(db, sha512): Promise<JarInfo | null>`, `storeJar(env, o): Promise<{ jar: JarInfo; created: boolean }>`
  - HTTP:
    - `PUT /admin/jars/:sha512?filename=&minecraft=&java=` takes a raw body and returns `JarUploadResponse` (201 created, 200 already there)
    - `GET /admin/jars/:sha512` returns `JarInfoBody`, or 404 `not_found`
    - `GET /jars/:sha512` returns the jar bytes (agent token or admin secret)

- [ ] **Step 1: Migration**

```sql
-- apps/worker/migrations/0003_jars.sql
-- Mod jars uploaded with /mod upload or mc-host admin jar add. The bytes are in R2 at jars/<sha512>.jar.
CREATE TABLE jars (
  sha512 TEXT PRIMARY KEY,
  sha1 TEXT NOT NULL,
  size INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mod_id TEXT,
  version TEXT,
  minecraft_range TEXT,
  java_range TEXT,
  depends_json TEXT NOT NULL,
  -- Discord user ID, or "admin" for the CLI.
  uploaded_by TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Protocol schemas** (append to `packages/protocol/src/index.ts`)

```ts
export const Sha512Schema = z.string().regex(/^[0-9a-f]{128}$/, "must be a lowercase hex sha512");
export const JarInfoSchema = z.object({
  sha512: Sha512Schema,
  sha1: z.string(),
  size: Size,
  filename: z.string(),
  modId: z.string().nullable(),
  version: z.string().nullable(),
  minecraftRange: z.string().nullable(),
  javaRange: z.string().nullable(),
  depends: z.array(z.string()),
});
export type JarInfoBody = z.infer<typeof JarInfoSchema>;
export const JarUploadResponseSchema = z.object({ jar: JarInfoSchema, created: z.boolean() });
export type JarUploadResponse = z.infer<typeof JarUploadResponseSchema>;
```

- [ ] **Step 3: Test helper** (append to `apps/worker/test/helpers.ts`)

```ts
import { strToU8, zipSync } from "fflate";

/** A minimal Fabric mod jar. */
export function fabricJar(o: Record<string, unknown> = {}): Uint8Array {
  const meta = { schemaVersion: 1, id: "dragonbond", version: "1.1.1", depends: { minecraft: "=26.3", java: ">=25", citadel: "*" }, ...o };
  return zipSync({ "fabric.mod.json": strToU8(JSON.stringify(meta)) });
}

export async function putJar(bytes: Uint8Array, q: { sha512?: string; filename?: string; minecraft?: string; java?: string } = {}, auth = `Bearer ${ADMIN_SECRET}`) {
  const sha512 = q.sha512 ?? (await sha512Hex(bytes));
  const params = new URLSearchParams({ filename: q.filename ?? "deeper end.jar", minecraft: q.minecraft ?? "26.3", java: q.java ?? "25" });
  const ctx = createExecutionContext();
  const res = await app.request(`/admin/jars/${sha512}?${params}`, { method: "PUT", headers: { Authorization: auth }, body: bytes }, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as any, sha512 };
}
```

Add `sha512Hex` to the existing `@mc/profile` import in `helpers.ts`.

- [ ] **Step 4: Write the failing tests**

```ts
// apps/worker/test/jars.vitest.ts
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { addUser, call, fabricJar, putJar } from "./helpers";

async function download(sha512: string, auth?: string) {
  const ctx = createExecutionContext();
  const res = await app.request(`/jars/${sha512}`, { headers: auth ? { Authorization: auth } : {} }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("PUT /admin/jars/:sha512", () => {
  it("stores the jar and its row, then reports it as already there", async () => {
    const bytes = fabricJar();
    const first = await putJar(bytes);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      created: true,
      jar: { sha512: first.sha512, filename: "deeper end.jar", modId: "dragonbond", version: "1.1.1", minecraftRange: "=26.3", depends: ["citadel"] },
    });
    expect(await env.BUCKET.head(`jars/${first.sha512}.jar`)).not.toBeNull();
    const again = await putJar(bytes);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });

  it("rejects a jar for another Minecraft version and stores nothing", async () => {
    const r = await putJar(fabricJar({ depends: { minecraft: "=26.1.2" } }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("deeper end.jar is built for Minecraft =26.1.2, but the profile is on 26.3.");
    expect(await env.BUCKET.head(`jars/${r.sha512}.jar`)).toBeNull();
    expect((await call("GET", `/admin/jars/${r.sha512}`, { admin: true })).status).toBe(404);
  });

  // Review focus 4: an existing row doesn't skip the check against a new target.
  it("checks a known jar again against the requested Minecraft version", async () => {
    const bytes = fabricJar();
    await putJar(bytes);
    const r = await putJar(bytes, { minecraft: "26.4" });
    expect(r.status).toBe(400);
  });

  it("rejects a body that doesn't match the sha512 in the path", async () => {
    const r = await putJar(fabricJar(), { sha512: "0".repeat(128) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("upload_missing");
  });

  it("rejects missing query parameters and a bad secret", async () => {
    expect((await putJar(fabricJar(), { java: "x" })).status).toBe(400);
    expect((await putJar(fabricJar(), {}, "Bearer nope")).status).toBe(401);
  });
});

describe("GET /admin/jars/:sha512", () => {
  it("returns the stored info", async () => {
    const { sha512 } = await putJar(fabricJar());
    const r = await call("GET", `/admin/jars/${sha512}`, { admin: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sha512, modId: "dragonbond", javaRange: ">=25" });
  });
});

describe("GET /jars/:sha512", () => {
  it("serves the bytes to a hosting token or the admin secret", async () => {
    const bytes = fabricJar();
    const { sha512 } = await putJar(bytes);
    const token = await addUser();
    for (const auth of [`Bearer ${token}`, "Bearer test-admin"]) {
      const res = await download(sha512, auth);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    }
  });

  it("refuses anonymous downloads and 404s unknown jars", async () => {
    const { sha512 } = await putJar(fabricJar());
    expect((await download(sha512)).status).toBe(401);
    expect((await download("0".repeat(128), "Bearer test-admin")).status).toBe(404);
  });
});
```

- [ ] **Step 5: Run them and watch them fail**

Run: `bun run --cwd apps/worker test -- jars`
Expected: FAIL (404 on every route).

- [ ] **Step 6: `apps/worker/src/jars.ts`**

```ts
import { inspectJar, type JarInfo, type JarTarget } from "@mc/profile";
import type { Env } from "./env";
import { ApiError } from "./errors";

export const MAX_JAR_BYTES = 32 * 1024 * 1024;
export const jarKey = (sha512: string): string => `jars/${sha512}.jar`;

interface JarRow {
  sha512: string;
  sha1: string;
  size: number;
  filename: string;
  mod_id: string | null;
  version: string | null;
  minecraft_range: string | null;
  java_range: string | null;
  depends_json: string;
}

const toInfo = (r: JarRow): JarInfo => ({
  sha512: r.sha512,
  sha1: r.sha1,
  size: r.size,
  filename: r.filename,
  modId: r.mod_id,
  version: r.version,
  minecraftRange: r.minecraft_range,
  javaRange: r.java_range,
  depends: JSON.parse(r.depends_json) as string[],
});

export async function getJar(db: D1Database, sha512: string): Promise<JarInfo | null> {
  const row = await db.prepare("SELECT * FROM jars WHERE sha512 = ?").bind(sha512).first<JarRow>();
  return row ? toInfo(row) : null;
}

/**
 * Check a jar against the target and keep it. The object goes to R2 before the row, so a row
 * always has its bytes. A jar that's already stored is still checked against this target.
 */
export async function storeJar(
  env: Pick<Env, "DB" | "BUCKET">,
  o: { bytes: Uint8Array; filename: string; target: JarTarget; by: string; now: number; expectSha512?: string },
): Promise<{ jar: JarInfo; created: boolean }> {
  if (o.bytes.length > MAX_JAR_BYTES) {
    throw new ApiError("bad_request", `${o.filename} is over ${MAX_JAR_BYTES / 1024 / 1024} MB, which is bigger than any mod should be.`);
  }
  const { problems, ...info } = await inspectJar(o.bytes, o.filename, o.target);
  if (o.expectSha512 && info.sha512 !== o.expectSha512) {
    throw new ApiError("upload_missing", "The upload doesn't match its sha512. Upload it again.");
  }
  if (problems.length) throw new ApiError("bad_request", problems.join(" "));
  const existing = await getJar(env.DB, info.sha512);
  if (existing) return { jar: existing, created: false };
  await env.BUCKET.put(jarKey(info.sha512), o.bytes);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO jars (sha512, sha1, size, filename, mod_id, version, minecraft_range, java_range, depends_json, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(info.sha512, info.sha1, info.size, info.filename, info.modId, info.version, info.minecraftRange, info.javaRange, JSON.stringify(info.depends), o.by, o.now)
    .run();
  return { jar: info, created: true };
}
```

- [ ] **Step 7: `agentOrAdminAuth` in `apps/worker/src/auth.ts`**

```ts
/** A hosting token, or the admin secret: maintainers also build servers on their own PC. */
export const agentOrAdminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (token && c.env.ADMIN_SECRET && (await sameSecret(token, c.env.ADMIN_SECRET))) {
    await next();
    return;
  }
  return agentAuth(c, next);
});
```

- [ ] **Step 8: Admin routes** (append to `apps/worker/src/routes/admin.ts`)

```ts
admin.put("/jars/:sha512", async (c) => {
  const sha512 = c.req.param("sha512");
  const filename = c.req.query("filename");
  const minecraft = c.req.query("minecraft");
  const javaMajor = Number(c.req.query("java"));
  if (!/^[0-9a-f]{128}$/.test(sha512) || !filename || !minecraft || !Number.isInteger(javaMajor)) {
    throw new ApiError("bad_request", "Send the jar as PUT /admin/jars/<sha512>?filename=…&minecraft=…&java=…");
  }
  if (Number(c.req.header("Content-Length") ?? 0) > MAX_JAR_BYTES) {
    throw new ApiError("bad_request", `${filename} is over ${MAX_JAR_BYTES / 1024 / 1024} MB, which is bigger than any mod should be.`);
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const body: JarUploadResponse = await storeJar(c.env, { bytes, filename, target: { minecraft, javaMajor }, by: "admin", now: Date.now(), expectSha512: sha512 });
  return c.json(body, body.created ? 201 : 200);
});

admin.get("/jars/:sha512", async (c) => {
  const jar = await getJar(c.env.DB, c.req.param("sha512"));
  if (!jar) throw new ApiError("not_found", "No jar with that sha512 has been uploaded.");
  const body: JarInfoBody = jar;
  return c.json(body);
});
```

Imports: `type JarInfoBody, type JarUploadResponse` from `@mc/protocol`, `ApiError` (already imported from `../errors`), and `getJar, MAX_JAR_BYTES, storeJar` from `../jars`.

- [ ] **Step 9: Download route**

```ts
// apps/worker/src/routes/jars.ts
import { Hono } from "hono";
import { agentOrAdminAuth } from "../auth";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { jarKey } from "../jars";

/** Uploaded mod jars for server builds. Never public: the lockfiles naming them are in a public repo. */
export const jars = new Hono<AppEnv>();
jars.use("*", agentOrAdminAuth);

jars.get("/:sha512", async (c) => {
  const sha512 = c.req.param("sha512");
  const obj = /^[0-9a-f]{128}$/.test(sha512) ? await c.env.BUCKET.get(jarKey(sha512)) : null;
  if (!obj) throw new ApiError("not_found", "That jar isn't uploaded. A maintainer can add it with /mod upload.");
  return new Response(obj.body, { headers: { "Content-Type": "application/java-archive", "Content-Length": String(obj.size) } });
});
```

In `apps/worker/src/index.ts`: `import { jars } from "./routes/jars";` and `app.route("/jars", jars);` after the `/modpack` line.

- [ ] **Step 10: Run the tests**

Run: `bun run --cwd apps/worker test && bun run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/worker packages/protocol
git commit -m "feat(worker): store uploaded jars in R2 and serve them to hosts"
```

---

### Task 5: `.mrpack` bundles uploaded jars, and `/mod list` tags them

**Files:**
- Modify: `apps/worker/src/mrpack.ts`
- Modify: `apps/worker/src/routes/modpack.ts`
- Modify: `apps/worker/src/commands/mod-list.ts`
- Test: `apps/worker/test/modpack.vitest.ts`, `apps/worker/test/info-commands.vitest.ts`

**Interfaces:**
- Consumes: `jarKey` (Task 4), `isUploadedJar` and `ExtraFile` (`@mc/profile`).
- Produces: `worldMrpack(env: Pick<Env, "BUCKET">, world: WorldRow): Promise<Uint8Array>`. The signature changes, and there's one caller.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/modpack.vitest.ts`:

```ts
describe("uploaded jars in the .mrpack", () => {
  // Review focus 3: a name with spaces goes in as-is.
  it("puts client jars under overrides/mods and leaves server-only ones out", async () => {
    const SHA_BOTH = "d".repeat(128);
    const SHA_SERVER = "e".repeat(128);
    await env.BUCKET.put(`jars/${SHA_BOTH}.jar`, new Uint8Array([1, 2, 3]));
    await env.BUCKET.put(`jars/${SHA_SERVER}.jar`, new Uint8Array([4]));
    const jar = (slug: string, side: "both" | "server", sha512: string, filename: string) =>
      lockEntry(slug, side, { projectId: "jar", source: "jar", sha512, filename, url: `jars/${sha512}` });
    await addWorld("w1", "active", [
      lockEntry("waystones", "both"),
      jar("dragonbond", "both", SHA_BOTH, "antiquetradingship-1.0.0 Fabric 26.3.jar"),
      jar("serverjar", "server", SHA_SERVER, "s.jar"),
    ]);
    const { res, bytes } = await getPack("w1.mrpack");
    expect(res.status).toBe(200);
    const zip = unzipSync(bytes);
    expect(zip["overrides/mods/antiquetradingship-1.0.0 Fabric 26.3.jar"]).toEqual(new Uint8Array([1, 2, 3]));
    expect(zip["overrides/mods/s.jar"]).toBeUndefined();
    const index = JSON.parse(strFromU8(zip["modrinth.index.json"]!));
    expect(index.files.map((f: { path: string }) => f.path)).toEqual(["mods/waystones-1.0.0.jar"]);
  });

  it("is a 500 when a pinned jar is missing from R2", async () => {
    const sha512 = "f".repeat(128);
    await addWorld("w1", "active", [lockEntry("gone", "both", { projectId: "jar", source: "jar", sha512, url: `jars/${sha512}` })]);
    expect((await getPack("w1.mrpack")).res.status).toBe(500);
  });
});
```

Append to the `/mod list` describe in `apps/worker/test/info-commands.vitest.ts`:

```ts
  it("tags uploaded jars", async () => {
    await addWorld("w1", "active", [lockEntry("dragonbond", "both", { source: "jar", versionNumber: "1.1.1" })]);
    expect(await content("mod list")).toContain("- dragonbond 1.1.1 (uploaded)");
  });
```

(`content` and `lockEntry` are already in that file's scope. Add the imports if they aren't.)

- [ ] **Step 2: Run them and watch them fail**

Run: `bun run --cwd apps/worker test -- modpack info-commands`
Expected: FAIL.

- [ ] **Step 3: `apps/worker/src/mrpack.ts`**

```ts
import { buildMrpack, isUploadedJar, parseLock, type ExtraFile } from "@mc/profile";
import type { Env } from "./env";
import { jarKey } from "./jars";
import type { WorldRow } from "./worlds";

export const modpackUrl = (origin: string, worldId: string): string => `${origin}/modpack/${worldId}.mrpack`;

/**
 * Built on request from the world's pinned lockfile. Modrinth mods are links; uploaded jars
 * that players need are read from R2 and bundled under overrides/mods/.
 */
export async function worldMrpack(env: Pick<Env, "BUCKET">, world: WorldRow): Promise<Uint8Array> {
  const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
  const profile = JSON.parse(world.profile_json) as { description?: string };
  const extras: ExtraFile[] = [];
  for (const f of lock.files) {
    if (!isUploadedJar(f) || f.side === "server") continue;
    const obj = await env.BUCKET.get(jarKey(f.sha512));
    if (!obj) throw new Error(`${world.name}'s lockfile pins ${f.filename} (jar ${f.sha512.slice(0, 12)}), but it isn't in R2`);
    extras.push({ path: `mods/${f.filename}`, data: new Uint8Array(await obj.arrayBuffer()) });
  }
  return buildMrpack(lock, { name: world.name, summary: profile.description }, extras);
}
```

In `routes/modpack.ts`, change the call to `await worldMrpack(c.env, world)`. Change the comment to: `/** Unauthenticated so Prism can import straight from the URL. Uploaded jars are bundled in, so the link is shared only in Discord. */`

- [ ] **Step 4: `/mod list` tag**

In `apps/worker/src/commands/mod-list.ts`, change the `notes` line to:

```ts
        const notes = [
          f.side === "both" && f.clientOptional ? "optional" : "",
          f.auto ? "dependency" : "",
          f.source === "jar" ? "uploaded" : "",
        ].filter(Boolean);
```

- [ ] **Step 5: Run the tests**

Run: `bun run --cwd apps/worker test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): the .mrpack bundles uploaded jars, and /mod list tags them"
```

---

### Task 6: `/mod upload`

**Files:**
- Create: `apps/worker/src/commands/mod-upload.ts`
- Modify: `apps/worker/src/discord/registry.ts` (`Attachment`, `interactionToken`, `attachments`)
- Modify: `apps/worker/src/discord/router.ts`
- Modify: `apps/worker/src/discord/respond.ts` (`deferred`)
- Modify: `apps/worker/src/discord/rest.ts` (`editOriginal`)
- Modify: `apps/worker/src/commands/index.ts`
- Test: `apps/worker/test/mod-upload.vitest.ts`

**Interfaces:**
- Consumes: `storeJar`, `MAX_JAR_BYTES` (Task 4); `jarName`, `jarProfileLine`, `dependencyHints`, `parseLock` (`@mc/profile`).
- Produces:
  - `interface Attachment { url: string; filename: string; size: number }`
  - `Invocation.interactionToken: string`
  - `CommandContext.attachments: Record<string, Attachment>`
  - `deferred(): APIInteractionResponse`
  - `editOriginal(env: Pick<Env, "DISCORD_APP_ID">, token: string, content: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/worker/test/mod-upload.vitest.ts
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postInteraction, slash } from "./discord";
import { addWorld, fabricJar } from "./helpers";

const ATT_URL = "https://cdn.discordapp.com/attachments/1/2/deeper_end.jar";

function upload(o: { side?: string; name?: string; filename?: string; size?: number; maintainer?: boolean } = {}) {
  const p: any = slash("mod upload", { side: o.side ?? "both", ...(o.name ? { name: o.name } : {}) }, { maintainer: o.maintainer ?? true });
  p.data.options[0].options.push({ name: "jar", type: 11, value: "att1" });
  p.data.resolved = { attachments: { att1: { id: "att1", url: ATT_URL, filename: o.filename ?? "deeper_end.jar", size: o.size ?? 100 } } };
  return p;
}

/** Serve the attachment, and record what's sent to Discord's webhook. */
function fakeDiscord(jar: Uint8Array | null) {
  const edits: { url: string; body: any }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as Request | string, init);
    if (req.url === ATT_URL) return jar ? new Response(jar) : new Response("gone", { status: 404 });
    edits.push({ url: req.url, body: await req.json() });
    return Response.json({ id: "1" });
  });
  return edits;
}

afterEach(() => vi.restoreAllMocks());

describe("/mod upload", () => {
  it("defers, stores the jar, and edits in the profile line with hints", async () => {
    await addWorld("w1");
    const edits = fakeDiscord(fabricJar());
    const r = await postInteraction(upload());
    expect(r.body).toEqual({ type: 5, data: { flags: 64 } });
    expect(edits).toHaveLength(1);
    expect(edits[0]!.url).toMatch(/\/webhooks\/200000000000000001\/interaction-token-\d+\/messages\/@original$/);
    const text: string = edits[0]!.body.content;
    expect(text).toContain("Stored deeper_end.jar (dragonbond 1.1.1).");
    expect(text).toMatch(/\{"jar":"dragonbond","filename":"deeper_end.jar","sha512":"[0-9a-f]{128}","side":"both"\}/);
    expect(text).toContain('Needs "citadel"');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jars").first("n")).toBe(1);
  });

  it("uses the name option and the server side", async () => {
    await addWorld("w1");
    const edits = fakeDiscord(fabricJar());
    await postInteraction(upload({ name: "deeper-end", side: "server" }));
    expect(edits[0]!.body.content).toContain('{"jar":"deeper-end",');
    expect(edits[0]!.body.content).toContain('"side":"server"}');
  });

  it("edits in the problem for a NeoForge jar", async () => {
    await addWorld("w1");
    const { zipSync } = await import("fflate");
    const edits = fakeDiscord(zipSync({ "META-INF/neoforge.mods.toml": new Uint8Array() }));
    await postInteraction(upload({ filename: "x-neoforge.jar" }));
    expect(edits[0]!.body.content).toBe("x-neoforge.jar is a NeoForge build. Get the Fabric build of this mod instead.");
  });

  it("answers right away for a non-jar, a huge file, no world, or a non-maintainer", async () => {
    fakeDiscord(fabricJar());
    expect((await postInteraction(upload())).body.data.content).toContain("mc-host admin jar add");
    await addWorld("w1");
    expect((await postInteraction(upload({ filename: "x.zip" }))).body.data.content).toBe("x.zip isn't a .jar file.");
    expect((await postInteraction(upload({ size: 40 * 1024 * 1024 }))).body.data.content).toContain("over 32 MB");
    expect((await postInteraction(upload({ maintainer: false }))).body.data.content).toBe("That needs the MC Maintainer role.");
  });

  it("edits in a download failure", async () => {
    await addWorld("w1");
    const edits = fakeDiscord(null);
    await postInteraction(upload());
    expect(edits[0]!.body.content).toBe("Couldn't download deeper_end.jar from Discord (HTTP 404). Try again.");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun run --cwd apps/worker test -- mod-upload`
Expected: FAIL ("I don't know that command").

- [ ] **Step 3: Registry types** (`apps/worker/src/discord/registry.ts`)

```ts
export interface Attachment {
  url: string;
  filename: string;
  size: number;
}
```

Add to `Invocation`:

```ts
  /** For editing a deferred reply. */
  interactionToken: string;
```

Add to `CommandContext`:

```ts
  /** Attachment options, by the attachment ID that is the option's value. */
  attachments: Record<string, Attachment>;
```

- [ ] **Step 4: Router** (`apps/worker/src/discord/router.ts`)

In `inv`, add `interactionToken: (i as { token?: string }).token ?? "",`. After `flatten(...)`, add:

```ts
      const attachments = (i.data as { resolved?: { attachments?: Record<string, Attachment> } }).resolved?.attachments ?? {};
```

Pass `{ ...inv, options, attachments }` in both `cmd.autocomplete(...)` and `cmd.run(...)`. Import `type Attachment` from `./registry`.

- [ ] **Step 5: `deferred` and `editOriginal`**

`respond.ts`:

```ts
/** "Thinking…" for work that may outlast Discord's 3-second limit. Finish it with editOriginal. */
export function deferred(): APIInteractionResponse {
  return { type: InteractionResponseType.DeferredChannelMessageWithSource, data: { flags: MessageFlags.Ephemeral } };
}
```

`rest.ts` (import `fit` from `./respond`; pull the User-Agent string into `const USER_AGENT = "DiscordBot (https://github.com/alexvtejeda/minecraft-discord-bot, 0.1.0)";` and use it in both functions):

```ts
/** Replace a deferred reply's "thinking…" with the result. */
export async function editOriginal(env: Pick<Env, "DISCORD_APP_ID">, token: string, content: string): Promise<void> {
  const res = await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ content: fit(content), allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status} to a reply edit: ${(await res.text()).slice(0, 300)}`);
}
```

- [ ] **Step 6: The command**

```ts
// apps/worker/src/commands/mod-upload.ts
import { dependencyHints, jarName, jarProfileLine, parseLock, type JarSide, type JarTarget } from "@mc/profile";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { Attachment, Command, CommandContext } from "../discord/registry";
import { deferred, OOPS, reply } from "../discord/respond";
import { editOriginal } from "../discord/rest";
import { ApiError } from "../errors";
import { MAX_JAR_BYTES, storeJar } from "../jars";
import { activeWorld } from "../worlds";

const MB = 1024 * 1024;

export const modUpload: Command = {
  path: "mod upload",
  description: "Check a mod jar and store it, then get the line to add to a profile",
  maintainerOnly: true,
  options: [
    { type: ApplicationCommandOptionType.Attachment, name: "jar", description: "The mod's Fabric .jar file", required: true },
    {
      type: ApplicationCommandOptionType.String,
      name: "side",
      description: "Who needs it",
      required: true,
      choices: [
        { name: "Everyone (server and players)", value: "both" },
        { name: "Server only", value: "server" },
      ],
    },
    { type: ApplicationCommandOptionType.String, name: "name", description: "Its name in the profile (default: the mod's ID)", required: false },
  ],
  async run(c) {
    const att = c.attachments[String(c.options.jar)];
    if (!att) return reply("Attach the mod's .jar file.");
    if (!att.filename.endsWith(".jar")) return reply(`${att.filename} isn't a .jar file.`);
    if (att.size > MAX_JAR_BYTES) {
      return reply(`${att.filename} is over ${MAX_JAR_BYTES / MB} MB. Upload it with \`mc-host admin jar add <profile> <file.jar>\` instead.`);
    }
    const world = await activeWorld(c.env.DB);
    if (!world) {
      return reply("There's no active world to check the jar against. Use `mc-host admin jar add <profile> <file.jar>` instead.");
    }
    const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
    const side: JarSide = c.options.side === "server" ? "server" : "both";
    const name = typeof c.options.name === "string" ? c.options.name : undefined;
    c.exec.waitUntil(finish(c, att, { minecraft: lock.minecraft, javaMajor: lock.javaMajor }, side, name));
    return deferred();
  },
};

async function finish(c: CommandContext, att: Attachment, target: JarTarget, side: JarSide, name: string | undefined): Promise<void> {
  let message: string;
  try {
    const res = await fetch(att.url);
    if (!res.ok) throw new ApiError("upstream", `Couldn't download ${att.filename} from Discord (HTTP ${res.status}). Try again.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { jar, created } = await storeJar(c.env, { bytes, filename: att.filename, target, by: c.userId, now: c.now });
    const line = jarProfileLine({ name: name ?? jarName(jar.modId, att.filename), filename: att.filename, sha512: jar.sha512, side });
    const what = [jar.modId, jar.version].filter(Boolean).join(" ") || "unknown mod";
    message = [
      created ? `Stored ${att.filename} (${what}).` : `${att.filename} was already stored (${what}).`,
      `Add this to the profile's "mods", run \`mc-host profile resolve <profile>\`, commit, deploy, then \`/world repin\`:`,
      "```json",
      line,
      "```",
      ...dependencyHints(jar.depends),
    ].join("\n");
  } catch (err) {
    if (!(err instanceof ApiError)) console.error("/mod upload failed", err);
    message = err instanceof ApiError ? err.message : OOPS;
  }
  await editOriginal(c.env, c.interactionToken, message).catch((err) => console.error("couldn't edit the /mod upload reply", err));
}
```

Register it in `apps/worker/src/commands/index.ts`: import `modUpload` and add it right after `modList` in `commands`. Also change the `mod` group description to `"Mods in the active world, and uploading jars"`.

- [ ] **Step 7: Run the tests**

Run: `bun run --cwd apps/worker test && bun run typecheck`
Expected: PASS. `definitions.vitest.ts` still lists the same top-level names, and `mod` stays visible because `mod list` is public.

- [ ] **Step 8: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): /mod upload checks and stores a jar from Discord"
```

---

### Task 7: `mc-host admin jar add`, and `profile resolve` looks jars up

**Files:**
- Modify: `apps/agent/src/host/api.ts` (`NotFoundError`, raw bodies, `putJar`, `getJar`)
- Modify: `apps/agent/src/cli.ts` (command, `--side`, usage)
- Modify: `apps/agent/src/admin.ts` (`addJar`)
- Modify: `apps/agent/src/commands.ts` (export `clientsFor`, jars client in `cmdResolve`, dispatch)
- Test: `apps/agent/test/admin.test.ts`, `apps/agent/test/cli.test.ts`, `apps/agent/test/commands.test.ts`

**Interfaces:**
- Consumes: `inspectJar`, `jarName`, `jarProfileLine`, `dependencyHints`, `isJarEntry`, `JarLookup` (`@mc/profile`); `JarInfoSchema`, `JarUploadResponseSchema` (`@mc/protocol`).
- Produces:
  - Command `{ kind: "admin-jar-add"; profile: string; file: string; side: string; name?: string; profilesDir: string }`
  - `AdminApi.putJar(o: { bytes: Uint8Array; sha512: string; filename: string; minecraft: string; javaMajor: number }): Promise<JarUploadResponse>`
  - `AdminApi.getJar(sha512: string): Promise<JarInfo | null>`
  - `export function clientsFor(deps: Deps): ResolveDeps`

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/cli.test.ts`:

```ts
test("admin jar add", () => {
  expect(parseCommand(["admin", "jar", "add", "cst", "mods/a b.jar"])).toEqual({
    kind: "admin-jar-add", profile: "cst", file: "mods/a b.jar", side: "both", name: undefined, profilesDir: "profiles",
  });
  expect(parseCommand(["admin", "jar", "add", "cst", "x.jar", "--side", "server", "--name", "x"])).toMatchObject({ side: "server", name: "x" });
  expect(() => parseCommand(["admin", "jar", "add", "cst"])).toThrow(/Missing <file.jar>/);
});
```

`apps/agent/test/admin.test.ts`: in `worker()`'s fake fetch, add these before the final 404:

```ts
    if (url.includes("/admin/jars/") && method === "PUT") {
      const sha512 = url.split("/admin/jars/")[1]!.split("?")[0]!;
      return json({ created: true, jar: { sha512, sha1: "1".repeat(40), size: 10, filename: "a b.jar", modId: "dragonbond", version: "1.1.1", minecraftRange: "=26.3", javaRange: null, depends: ["citadel"] } }, 201);
    }
```

Then the tests:

```ts
import { strToU8, zipSync } from "fflate";
import { fakeFabric, fakeMojang, FakeModrinth } from "../../../packages/profile/test/fakes";

const jarBytes = (mc = "=26.3") => zipSync({ "fabric.mod.json": strToU8(JSON.stringify({ schemaVersion: 1, id: "dragonbond", version: "1.1.1", depends: { minecraft: mc, citadel: "*" } })) });

test("admin jar add checks, uploads and prints the profile line", async () => {
  const dir = await profilesDir();
  const file = join(dir, "a b.jar");
  writeFileSync(file, jarBytes());
  const { fetch, seen } = worker();
  const logs: string[] = [];
  const d = { ...deps(fetch, logs), clients: { modrinth: new FakeModrinth(), fabric: fakeFabric, mojang: fakeMojang } };
  await runAdmin({ kind: "admin-jar-add", profile: "test", file, side: "both", profilesDir: dir }, d);
  const put = seen.find((s) => s.method === "PUT")!;
  expect(put.url).toMatch(/^https:\/\/w\.test\/admin\/jars\/[0-9a-f]{128}\?filename=a\+b\.jar&minecraft=26\.3&java=25$/);
  expect(logs[0]).toBe("Uploaded a b.jar (dragonbond 1.1.1).");
  expect(logs[1]).toBe('Add this to "mods" in test.json, then run "mc-host profile resolve test":');
  expect(logs[2]).toMatch(/^ {2}\{"jar":"dragonbond","filename":"a b.jar","sha512":"[0-9a-f]{128}","side":"both"\}$/);
  expect(logs[3]).toContain('Needs "citadel"');
});

test("admin jar add stops before uploading a jar for another version", async () => {
  const dir = await profilesDir();
  const file = join(dir, "old.jar");
  writeFileSync(file, jarBytes("=26.1.2"));
  const { fetch, seen } = worker();
  const d = { ...deps(fetch, []), clients: { modrinth: new FakeModrinth(), fabric: fakeFabric, mojang: fakeMojang } };
  await expect(runAdmin({ kind: "admin-jar-add", profile: "test", file, side: "both", profilesDir: dir }, d)).rejects.toThrow(
    "old.jar is built for Minecraft =26.1.2, but the profile is on 26.3.",
  );
  expect(seen.some((s) => s.method === "PUT")).toBe(false);
});

test("admin jar add rejects a bad --side", async () => {
  const dir = await profilesDir();
  const d = deps(worker().fetch, []);
  await expect(runAdmin({ kind: "admin-jar-add", profile: "test", file: "x.jar", side: "client", profilesDir: dir }, d)).rejects.toThrow(
    '--side must be "server" or "both", not "client".',
  );
});
```

`apps/agent/test/commands.test.ts`. Mirror that file's existing resolve test setup (temp profiles dir, `deps.clients` with `FakeModrinth`) and add:

```ts
test("resolve looks uploaded jars up through the admin API", async () => {
  const SHA = "b".repeat(128);
  writeProfile({ mods: [{ jar: "dragonbond", filename: "d.jar", sha512: SHA, side: "both" }], waiting: [] });
  const seen: string[] = [];
  const fetch: Deps["fetch"] = async (url) => {
    seen.push(url);
    return url === `https://w.test/admin/jars/${SHA}`
      ? Response.json({ sha512: SHA, sha1: "1".repeat(40), size: 5, filename: "d.jar", modId: "dragonbond", version: "1.1.1", minecraftRange: "=26.3", javaRange: null, depends: [] })
      : Response.json({ error: "not_found", message: "nope" }, { status: 404 });
  };
  await runCommand(
    { kind: "resolve", name: "test", addReady: false, profilesDir: dir },
    { ...deps, fetch, env: { MC_WORKER_URL: "https://w.test", MC_ADMIN_SECRET: "s" } },
  );
  const lock = parseLock(readFileSync(join(dir, "test.lock.json"), "utf8"), "lock");
  expect(lock.files).toHaveLength(1);
  expect(lock.files[0]).toMatchObject({ slug: "dragonbond", source: "jar", url: `jars/${SHA}`, versionNumber: "1.1.1" });
  expect(seen).toEqual([`https://w.test/admin/jars/${SHA}`]);
});

test("resolve without admin config names what's missing", async () => {
  writeProfile({ mods: [{ jar: "dragonbond", filename: "d.jar", sha512: "b".repeat(128), side: "both" }], waiting: [] });
  await expect(runCommand({ kind: "resolve", name: "test", addReady: false, profilesDir: dir }, { ...deps, env: {} })).rejects.toThrow(/MC_ADMIN_SECRET/);
});
```

(`dir`, `deps`, `writeProfile` and `runCommand` are already set up at the top of `commands.test.ts`.)

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test apps/agent/test/cli.test.ts apps/agent/test/admin.test.ts apps/agent/test/commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: `host/api.ts`**

Add the class next to the other errors:

```ts
/** The Worker has no such thing. */
export class NotFoundError extends UserError {}
```

In `request`, widen `method` to `"GET" | "POST" | "PUT"` and send raw bytes as-is:

```ts
  const raw = body instanceof Uint8Array;
  ...
      headers: {
        Authorization: `Bearer ${c.secret}`,
        [AGENT_VERSION_HEADER]: VERSION,
        ...(body === undefined ? {} : { "Content-Type": raw ? "application/octet-stream" : "application/json" }),
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
```

In the error branch, before `throw new UserError(message);`:

```ts
  if (error === "not_found") throw new NotFoundError(message);
```

Add to `AdminApi` and `createAdminApi`:

```ts
  putJar(o: { bytes: Uint8Array; sha512: string; filename: string; minecraft: string; javaMajor: number }): Promise<JarUploadResponse>;
  /** Null when no jar with that sha512 was uploaded. */
  getJar(sha512: string): Promise<JarInfo | null>;
```

```ts
    putJar: (o) =>
      request(
        c,
        "PUT",
        `/admin/jars/${o.sha512}?${new URLSearchParams({ filename: o.filename, minecraft: o.minecraft, java: String(o.javaMajor) })}`,
        JarUploadResponseSchema,
        o.bytes,
      ),
    getJar: async (sha512) => {
      try {
        return await request(c, "GET", `/admin/jars/${sha512}`, JarInfoSchema);
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
```

Imports: `JarInfoSchema, JarUploadResponseSchema, type JarUploadResponse` from `@mc/protocol`, and `type JarInfo` from `@mc/profile`.

- [ ] **Step 4: CLI** (`apps/agent/src/cli.ts`)

Add to the `Command` union:

```ts
  | { kind: "admin-jar-add"; profile: string; file: string; side: string; name?: string; profilesDir: string }
```

Add `side: { type: "string", default: "both" },` to the `parseArgs` options. In the `admin` case, before the final `throw unknown`:

```ts
      if (sub === "jar" && a === "add") {
        return { kind: "admin-jar-add", profile: need(b, "<profile>"), file: need(c, "<file.jar>"), side: values.side ?? "both", name: values.name, profilesDir };
      }
```

Add to `USAGE` under Maintainers, after `admin world create`:

```
  admin jar add <profile> <file.jar> [--side both|server] [--name <name>]
      Check a mod jar against <profile>, upload it, and print the line for its "mods".
      --side         "both" (default: the server and every player) or "server"
      --name         its name in the profile (default: the mod's ID)
```

- [ ] **Step 5: `admin.ts`**

Widen `AdminCommand` to include `"admin-jar-add"`. Add:

```ts
async function addJar(cmd: Extract<AdminCommand, { kind: "admin-jar-add" }>, api: AdminApi, deps: Deps): Promise<void> {
  if (cmd.side !== "server" && cmd.side !== "both") throw new UserError(`--side must be "server" or "both", not "${cmd.side}".`);
  const side = cmd.side;
  const { profile } = await loadProfile(cmd.profilesDir, cmd.profile);
  if (!existsSync(cmd.file)) throw new UserError(`${cmd.file} doesn't exist. Check the path and try again.`);
  const bytes = new Uint8Array(await readFile(cmd.file));
  const filename = basename(cmd.file);
  const target = { minecraft: profile.minecraft, javaMajor: await clientsFor(deps).mojang.javaMajor(profile.minecraft) };
  const report = await inspectJar(bytes, filename, target);
  if (report.problems.length) throw new UserError(report.problems.join("\n"));
  const { jar, created } = await api.putJar({ bytes, sha512: report.sha512, filename, ...target });
  const what = [jar.modId, jar.version].filter(Boolean).join(" ") || "unknown mod";
  deps.log(created ? `Uploaded ${filename} (${what}).` : `${filename} was already uploaded (${what}).`);
  deps.log(`Add this to "mods" in ${profile.name}.json, then run "mc-host profile resolve ${profile.name}":`);
  deps.log(`  ${jarProfileLine({ name: cmd.name ?? jarName(jar.modId, filename), filename, sha512: jar.sha512, side })}`);
  for (const h of dependencyHints(jar.depends)) deps.log(h);
}
```

Imports: `readFile` from `node:fs/promises`, `basename` from `node:path`, `inspectJar, jarName, jarProfileLine, dependencyHints` from `@mc/profile`, and `clientsFor` from `./commands`. In `runAdmin`'s switch: `case "admin-jar-add": return addJar(cmd, api, deps);`.

The admin config is loaded before `addJar` runs, so a missing `MC_ADMIN_SECRET` fails before the jar is read. That's fine.

- [ ] **Step 6: `commands.ts`**

Export `clientsFor` (change `function clientsFor` to `export function clientsFor`). Add the dispatch case `case "admin-jar-add":` next to the other admin cases. In `cmdResolve`, replace the `resolveProfile` call with:

```ts
  const jars = clients.jars ?? (profile.mods.some(isJarEntry) ? await adminJars(deps) : undefined);
  const { lock, warnings, waiting } = await resolveProfile(profile, { ...clients, jars });
```

And add:

```ts
/** Uploaded jars are looked up on the Worker with the admin secret. */
async function adminJars(deps: Deps): Promise<JarLookup> {
  const api = createAdminApi({ ...(await loadAdminConfig(deps.env ?? process.env, deps.configDir)), fetch: deps.fetch });
  return { lookup: (sha512) => api.getJar(sha512) };
}
```

Imports: `isJarEntry, type JarLookup` from `@mc/profile`, `createAdminApi` from `./host/api`, `loadAdminConfig` from `./host/config`.

- [ ] **Step 7: Run the tests**

Run: `bun test apps/agent && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): mc-host admin jar add, and resolve looks up uploaded jars"
```

---

### Task 8: Hosts and local builds download uploaded jars; agent 0.3.0

**Files:**
- Modify: `apps/agent/src/download.ts` (`JarSource`, `sourceFor`)
- Modify: `apps/agent/src/server/build.ts`
- Modify: `apps/agent/src/host/commands.ts`
- Modify: `apps/agent/src/commands.ts` (`localJarSource`, `cmdBuildServer`, `cmdBuildMrpack`)
- Modify: `apps/agent/src/packs/command.ts`
- Modify: `apps/agent/package.json` (`"version": "0.3.0"`)
- Modify: `apps/worker/wrangler.jsonc` (`"MIN_AGENT_VERSION": "0.3.0"`)
- Test: `apps/agent/test/build.test.ts`, `apps/agent/test/download.test.ts`

**Interfaces:**
- Consumes: `isUploadedJar` (Task 3), `GET /jars/:sha512` (Task 4).
- Produces:
  - `interface JarSource { workerUrl: string; secret: string }`
  - `sourceFor(f: LockEntry, fetch: Fetch, jars: JarSource | undefined): { url: string; fetch: Fetch }`
  - `BuildServerOptions.jarSource?: JarSource`
  - `localJarSource(deps: Deps, lock: Lockfile): Promise<JarSource | undefined>`

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/download.test.ts`:

```ts
import { sourceFor } from "../src/download";

test("sourceFor leaves Modrinth entries alone and points jars at the Worker with auth", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    return new Response("ok");
  };
  const mr = { url: "https://cdn.modrinth.com/x.jar", source: undefined } as LockEntry;
  expect(sourceFor(mr, fetch, undefined).url).toBe("https://cdn.modrinth.com/x.jar");
  const jar = { url: `jars/${"a".repeat(128)}`, source: "jar", filename: "a b.jar" } as LockEntry;
  const s = sourceFor(jar, fetch, { workerUrl: "https://w.test", secret: "tok" });
  expect(s.url).toBe(`https://w.test/jars/${"a".repeat(128)}`);
  await s.fetch(s.url, { headers: { "User-Agent": "ua" } });
  expect(calls).toEqual([{ url: s.url, auth: "Bearer tok" }]);
  expect(() => sourceFor(jar, fetch, undefined)).toThrow(/a b\.jar is an uploaded jar/);
});
```

`apps/agent/test/build.test.ts` (use the file's `entry()` helper and its fake-fetch pattern):

```ts
// Review focus 3 and 5.
test("uploaded jars come from the Worker with the token, spaces and all", async () => {
  const jar = { ...(await entry("deeper end", "both")), filename: "deeper end.jar", url: `jars/${"a".repeat(128)}`, source: "jar" as const };
  const seen: { url: string; auth: string | null }[] = [];
  const fetch: Fetch = async (url, init) => {
    seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    return new Response(url.includes("/jars/") ? bytes("deeper end") : bytes("launcher"));
  };
  await buildServer({ profile: makeProfile(), lock: await lockWith([jar]), dir: serverDir, fetch, cacheDir: cache, userAgent: "t", jarSource: { workerUrl: "https://w.test", secret: "tok" } });
  expect(readdirSync(join(serverDir, "mods"))).toEqual(["deeper end.jar"]);
  expect(seen.find((s) => s.url.includes("/jars/"))).toEqual({ url: `https://w.test/jars/${"a".repeat(128)}`, auth: "Bearer tok" });
});

test("a lock with uploaded jars and no jarSource fails before touching the folder", async () => {
  const jar = { ...(await entry("x", "both")), url: `jars/${"a".repeat(128)}`, source: "jar" as const };
  await expect(buildServer({ profile: makeProfile(), lock: await lockWith([jar]), dir: serverDir, fetch: async () => new Response(""), cacheDir: cache, userAgent: "t" })).rejects.toThrow(
    /x\.jar is an uploaded jar/,
  );
  expect(existsSync(serverDir)).toBe(false);
});
```

Add this helper next to `makeLock` in `build.test.ts`:

```ts
const lockWith = async (files: LockEntry[]): Promise<Lockfile> => ({ ...(await makeLock()), files });
```

and use `lock: await lockWith([jar])` in both tests above.

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test apps/agent/test/download.test.ts apps/agent/test/build.test.ts`
Expected: FAIL.

- [ ] **Step 3: `download.ts`**

```ts
/** The Worker that serves uploaded jars, and a hosting token or the admin secret for it. */
export interface JarSource {
  workerUrl: string;
  secret: string;
}

/** Where a lock entry downloads from: Modrinth's CDN as-is, uploaded jars from the Worker with auth. */
export function sourceFor(f: LockEntry, fetch: Fetch, jars: JarSource | undefined): { url: string; fetch: Fetch } {
  if (!isUploadedJar(f)) return { url: f.url, fetch };
  if (!jars) {
    throw new UserError(`${f.filename} is an uploaded jar, so building needs the Worker: set MC_WORKER_URL with MC_TOKEN or MC_ADMIN_SECRET.`);
  }
  const authed: Fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${jars.secret}`);
    return fetch(input, { ...init, headers });
  };
  return { url: `${jars.workerUrl.replace(/\/+$/, "")}/${f.url}`, fetch: authed };
}
```

Imports: `isUploadedJar, type LockEntry` from `@mc/profile`.

- [ ] **Step 4: `server/build.ts`**

Add to `BuildServerOptions`:

```ts
  /** Needed when the lockfile has uploaded jars. */
  jarSource?: JarSource;
```

Resolve sources in the filename-validation loop, so a missing source fails before `guardFolder`:

```ts
  const sources = wanted.map((f) => sourceFor(f, o.fetch, o.jarSource));
```

(Put that line right after the existing `for (const f of wanted) { …unsafe file name… }` loop.) Replace the jar download loop with:

```ts
  for (const [i, f] of wanted.entries()) {
    const s = sources[i]!;
    jars.push([await fetchVerified(s.url, f.sha512, { ...dl, fetch: s.fetch }), f.filename]);
  }
```

- [ ] **Step 5: Callers**

`host/commands.ts`, in `build`:

```ts
      await buildServer({ profile, lock, dir, fetch: deps.fetch, cacheDir: deps.cacheDir, userAgent: USER_AGENT, log: deps.log, jarSource: { workerUrl: cfg.workerUrl, secret: cfg.token } });
```

`commands.ts`: add

```ts
/** Only needed when the lockfile has uploaded jars. Prefers the admin secret, then this PC's hosting token. */
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
```

Pass `jarSource: await localJarSource(deps, lock)` in `cmdBuildServer`'s `buildServer` call and in `packs/command.ts`'s `buildServer` call. In `cmdBuildMrpack`, build the extras:

```ts
  const source = await localJarSource(deps, lock);
  const extras: ExtraFile[] = [];
  for (const f of lock.files.filter((f) => isUploadedJar(f) && f.side !== "server")) {
    const s = sourceFor(f, deps.fetch, source);
    const path = await fetchVerified(s.url, f.sha512, { fetch: s.fetch, cacheDir: deps.cacheDir, userAgent: USER_AGENT });
    extras.push({ path: `mods/${f.filename}`, data: new Uint8Array(await readFile(path)) });
  }
  const bytes = await buildMrpack(lock, { name: `${profile.name} (Minecraft ${lock.minecraft})`, summary: profile.description }, extras);
```

Imports: `isUploadedJar, type ExtraFile` from `@mc/profile`, `fetchVerified, sourceFor, type JarSource` from `./download`, and `loadHostConfig` from `./host/config`.

- [ ] **Step 6: Version bump**

`apps/agent/package.json`: `"version": "0.3.0"`. `apps/worker/wrangler.jsonc`: `"MIN_AGENT_VERSION": "0.3.0"`. Hosts on 0.2.0 would fail on a relative jar URL. With this bump they're told to run `/setup host` instead.

- [ ] **Step 7: Run everything**

Run: `bun test && bun run --cwd apps/worker test && bun run typecheck`
Expected: PASS. If `version.vitest.ts` hard-codes `0.2.0` for the deployed config, update it to `0.3.0`.

- [ ] **Step 8: Commit**

```bash
git add apps/agent apps/worker/wrangler.jsonc
git commit -m "feat(agent): download uploaded jars from the Worker; agent 0.3.0"
```

---

### Task 9: `check-packs` boots mods-only profiles and names Fabric's mod problems

**Files:**
- Modify: `apps/agent/src/packs/logscan.ts` (`fabricModProblems`)
- Modify: `apps/agent/src/packs/check.ts`
- Modify: `apps/agent/src/packs/command.ts`
- Modify: `apps/agent/src/cli.ts` (`packsDir?: string`, usage)
- Test: `apps/agent/test/logscan.test.ts`, `apps/agent/test/check-packs.test.ts`, `apps/agent/test/cli.test.ts`

**Interfaces:**
- Produces: `fabricModProblems(lines: string[]): string[]`. The `check-packs` command's `packsDir` becomes optional.

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/logscan.test.ts`:

```ts
import { fabricModProblems } from "../src/packs/logscan";

const FABRIC_FAIL = [
  "[12:00:00] [main/INFO]: Loading 52 mods",
  "[12:00:01] [main/ERROR]: Incompatible mods found!",
  "net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
  "A potential solution has been determined, this may resolve your problem:",
  "\t - Install citadel, version 26.3-1.0.0 or later.",
  "More details:",
  "\t - Mod 'Alex's Mobs' (alexsmobs) 1.0.0 requires version 26.3-1.0.0 or later of mod 'citadel', which is missing!",
  "\tat net.fabricmc.loader.impl.FormattedException.ofLocalized(FormattedException.java:51)",
  "\t - not part of the report",
];

test("fabricModProblems lists the report's items once each", () => {
  expect(fabricModProblems(FABRIC_FAIL)).toEqual([
    "Install citadel, version 26.3-1.0.0 or later.",
    "Mod 'Alex's Mobs' (alexsmobs) 1.0.0 requires version 26.3-1.0.0 or later of mod 'citadel', which is missing!",
  ]);
  expect(fabricModProblems(["[12:00:00] [main/INFO]: Done"])).toEqual([]);
});
```

`apps/agent/test/check-packs.test.ts`:

```ts
test("a mod problem at the baseline boot is reported by name", async () => {
  const s = scripted(() => ({
    lines: [
      "[12:00:01] [main/ERROR]: Incompatible mods found!",
      "\t - Install citadel, version 26.3-1.0.0 or later.",
    ],
    started: false,
  }));
  await expect(checkPacks([], s.boot, () => {})).rejects.toThrow("The server doesn't start because of its mods:\n  - Install citadel, version 26.3-1.0.0 or later.");
});

test("no packs: one boot, and a mods summary", async () => {
  const s = scripted(() => ok());
  const r = await checkPacks([], s.boot, () => {});
  expect(s.calls).toHaveLength(1);
  expect(formatReport(r).summary).toBe("The mods loaded without errors (1 boots).");
});
```

`apps/agent/test/cli.test.ts`. Replace the `Missing --packs <folder>` expectation with:

```ts
  expect(parseCommand(["profile", "check-packs", "cst"])).toMatchObject({ kind: "check-packs", name: "cst", packsDir: undefined });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test apps/agent/test/logscan.test.ts apps/agent/test/check-packs.test.ts apps/agent/test/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: `logscan.ts`**

```ts
const FABRIC_REPORT = /Incompatible mods? found|Some of your mods are incompatible|Mod resolution failed/i;
const FABRIC_ITEM = /^\s*-\s+(.+)$/;

/** The " - …" items of Fabric's incompatible-mods report: what's missing or clashing. */
export function fabricModProblems(lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (FABRIC_REPORT.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (STACK.test(line) || HEADER.test(line)) {
      inside = false;
      continue;
    }
    const item = FABRIC_ITEM.exec(line)?.[1]?.trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}
```

`STACK` matches `"\tat …"`, so the report ends at the stack trace.

- [ ] **Step 4: `check.ts`**

In `checkPacks`, inside `if (!base.started) {`, first:

```ts
    const mods = fabricModProblems(base.lines);
    if (mods.length) throw new UserError(`The server doesn't start because of its mods:\n${mods.map((m) => `  - ${m}`).join("\n")}`);
```

Change the baseline log line to `log(packs.length ? "Booting without datapacks first, to see which errors the mods cause on their own…" : "Booting with the mods only…");`.

In `formatReport`, before the `failed.size` return:

```ts
  if (n === 0) return { lines, summary: `The mods loaded without errors ${boots}.`, ok: true };
```

Import `fabricModProblems` from `./logscan`.

- [ ] **Step 5: CLI and command**

`cli.ts`: in the `check-packs` command type, `packsDir?: string`. In the parse, `packsDir: values.packs,` (drop the `need`). In USAGE, change the line to `profile check-packs <profile> [--packs <folder>] [--all] [--keep]` and its description to `Boot a test server and name the mods or datapacks with errors.` with `--packs` described as `the datapack zips (not needed when the profile has none)`.

`packs/command.ts`: replace the start of `packFiles` with:

```ts
async function packFiles(cmd: Extract<Command, { kind: "check-packs" }>, datapacks: string[]): Promise<string[]> {
  if (!cmd.all && !datapacks.length) return [];
  if (!cmd.packsDir) {
    throw new UserError(cmd.all ? "--all needs --packs <folder>." : `${cmd.name} has ${datapacks.length} datapacks. Add --packs <folder> pointing at their zips.`);
  }
  if (!existsSync(cmd.packsDir)) throw new UserError(`The --packs folder ${cmd.packsDir} doesn't exist. Check the path and try again.`);
  const names = await readdir(cmd.packsDir);
```

Remove the old `if (!datapacks.length) throw …` line. Below it, keep the rest of the function and use `cmd.packsDir` as-is (TypeScript narrows it after the check). In `cmdCheckPacks`:
- change the "Checking N datapacks" log to `deps.log(files.length ? \`Checking ${files.length} datapacks against ${profile.name} (Minecraft ${lock.minecraft})…\` : \`Checking ${profile.name}'s mods (Minecraft ${lock.minecraft})…\`);`
- pass `packsDir: cmd.packsDir ?? dir` to `createBoot`. With no packs, `createBoot` never copies from it.

- [ ] **Step 6: Run the tests**

Run: `bun test apps/agent && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): check-packs boots mods-only profiles and names Fabric's mod problems"
```

---

### Task 10: Docs and rollout

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-local-jars-design.md` (apply the "Changes from the spec" table)
- Modify: `ROADMAP.md`
- Create: `docs/setup/local-jars.md`

- [ ] **Step 1: Update the spec**

Edit the spec so it matches what was built. In particular:
- The admin API section becomes the single `PUT /admin/jars/<sha512>?filename=&minecraft=&java=`.
- The error code is `bad_request`.
- The size limit is 32 MB.
- `/mod upload` has no bundled-profile fallback.
- The CLI is `mc-host admin jar add <profile> <file.jar>`.
- The D1 table includes `java_range` and `depends_json`.
- check-packs has a mods-only boot.

- [ ] **Step 2: ROADMAP**

Add after Phase 4:

```markdown
## Local jars
Design: [docs/superpowers/specs/2026-10-03-local-jars-design.md](docs/superpowers/specs/2026-10-03-local-jars-design.md)
Guide: [docs/setup/local-jars.md](docs/setup/local-jars.md)
- [x] `inspectJar`, jar entries in profiles, resolved into the lockfile
- [x] Worker: jars in R2, `GET /jars/<sha512>` for hosts, bundled into the `.mrpack`
- [x] `mc-host admin jar add` and `/mod upload`
- [x] `check-packs` boots mods-only profiles and names missing dependencies
- [ ] Release v0.3.0, deploy, add the CurseForge jars to `cst`
```

Remove the "`/mod add` by Modrinth slug" item from **Later** only if the user asks. Leave it otherwise.

- [ ] **Step 3: Write `docs/setup/local-jars.md`**

```markdown
# Local jars: rollout and everyday use

## Rollout (once)

1. Release the agent first, so hosts can update before the Worker turns 0.2.0 away:
   `git tag v0.3.0 && git push origin v0.3.0`, and wait for the release workflow.
2. Apply the migration and deploy:
   ```bash
   cd apps/worker
   bunx wrangler d1 migrations apply mc-bot --remote   # adds the jars table
   bun run deploy
   bun run register   # adds /mod upload
   ```
3. Tell hosts to run `/setup host` once to get mc-host 0.3.0.

## Adding a jar

From the terminal (any size up to 32 MB):

    mc-host admin jar add cst "mods/the-deeper-end-fabric-1.1.1.jar"

From Discord: `/mod upload jar:<file> side:Everyone`.

Either way you get one line. Paste it into the profile's `"mods"`, then:

    mc-host profile resolve cst
    mc-host profile check-packs cst      # boots the server; names missing dependencies
    git commit -am "feat(profiles): add <mod> to cst"

Deploy, then `/world repin`.

## Removing a jar

Delete its line, resolve, commit, deploy, `/world repin`. The jar stays in R2 so older
snapshots can still be rolled back to.
```

- [ ] **Step 4: Commit**

```bash
git add docs ROADMAP.md
git commit -m "docs: local jars guide; spec matches the plan"
```

- [ ] **Step 5: Manual check (with the user, after the rollout)**

Run `mc-host admin jar add cst <file>` on each new jar in `mods/`. Expected:

| Jar | Expected |
|---|---|
| `bosslike-ender-dragon-1.1.0-26.3-fabric.jar` | uploaded, no hints |
| `the-deeper-end-fabric-1.1.1.jar` | uploaded as `dragonbond`, no hints |
| `alexsmobsfabric-26.3-1.0.0.jar` | uploaded, hint `Needs "citadel"` |
| `lootintegrations_vanilla-1.8.jar` | uploaded, hint `Needs "lootintegrations"` |
| `more_mobs-v1.5.11-mc1.14-26.3.9-mod.jar` | uploaded; remove `more-mobs` from `cst`'s `waiting` when adding it |
| `world-bosses-neoforge-26.3-2.0.1.jar` | rejected: `built for Minecraft =26.1.2` |
| `BiomesOPlenty-forge-…jar` (and the other NeoForge copies) | rejected: `is a Forge build` / `is a NeoForge build` |
| `ClickMobs-1.3.4+26.3-fabric.jar` (0 bytes) | rejected: `isn't a valid jar` |

Then paste the lines into `profiles/cst.json`, run `mc-host profile resolve cst` and `mc-host profile check-packs cst`, and join through Prism. To repin to `cst`, the Worker must bundle it: add the `cst` pair to `RAW` in `apps/worker/src/profiles.ts` and deploy.
