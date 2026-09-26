# Phase 1: World Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a small JSON profile into a pinned lockfile, a runnable Fabric server folder and a `.mrpack` for Prism Launcher, and ship two real profiles (`vanilla-plus`, `adventure`) for Minecraft 26.3.

**Architecture:** A Bun workspace with two parts:
- `packages/profile` is pure TypeScript that the Cloudflare Worker can import later. It uses only `fetch`, WebCrypto, zod and fflate, and it contains:
  - the profile schema
  - the Modrinth, Fabric and Mojang API clients
  - the dependency resolver
  - the lockfile format
  - the `.mrpack` builder
- `apps/agent` is the `mc-host` CLI. It holds everything that touches the disk:
  - the download cache
  - the server-folder builder
  - EULA handling and the Java check
  - running the server
  - the commands

**Tech Stack:** Bun 1.3 (runtime, test runner, `--compile`), TypeScript 5, zod 4, fflate 0.8. No other runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-phase-1-profiles-design.md` (parent: `docs/superpowers/specs/2026-09-25-minecraft-discord-bot-design.md`). Read the spec before starting any task.

## Global Constraints

- **Target:** Minecraft `26.3`, which needs Java 25. The Fabric loader is picked with `"latest-stable"` (0.19.5 at the time of writing), and the installer with the latest stable (1.1.2).
- **Sides:** exactly `server`, `both` and `client-optional`. `clientOptional: true` is allowed only on `both`.
- **`.mrpack` `env` mapping:**
  - `both` → `{client: required|optional, server: required}`
  - `client-optional` → `{client: optional, server: unsupported}`
  - `server` files are left out of the pack.
- **User-Agent:** every HTTP request sends `alexvtejeda/minecraft-discord-bot/0.1.0 (github.com/alexvtejeda/minecraft-discord-bot)`, exported as `USER_AGENT`.
- **Error messages:** user-facing errors are `UserError` and written in plain English. Each says what to do next. The CLI prints only the message and exits with code 1. Any other error prints a stack trace and exits with code 2.
- **Lockfile:** same input, same bytes. Files are sorted by slug, with 2-space JSON, a trailing newline, and no timestamps.
- **`packages/profile`** must not import `node:*` or `bun:*` outside its tests, because the Worker reuses it.
- **Public repo:** never commit jars, zips, worlds or secrets. `.gitignore` already covers them. Never read or print `.env`.
- **EULA:** never accept it for the user. The user must type `yes` once, and the answer is remembered in the agent config.
- **Datapacks:** Vanilla Tweaks has no 26.3 datapacks yet, so the 26.2 zips are used. A manual check in Task 11 confirms they're enabled.
- **Tests:** `bun test` makes no network calls. Only `LIVE=1 bun test live` reaches the real APIs.
- **Commits:** every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A library listed as `server` but required by a `both` mod** (for example `fabric-api` under Waystones) must become `both` and be required on the client. Otherwise players crash on join. Tested in Task 4.
2. **A server-only library pulled in by a `both` mod** (Modrinth `client_side: unsupported`) must never be sent to clients. Tested in Task 4.
3. **Editing a profile after resolving** must make `build-server` and `build-mrpack` refuse the stale lockfile, not quietly build the old mod set. Tested in Task 9.
4. **A lockfile update that drops a mod** must remove its jar from `mods/` and leave non-jar files (configs) alone. Otherwise the server keeps loading a mod the profile removed. Tested in Task 7.
5. **Vanilla Tweaks file names with spaces, versions and parentheses** (`afk display v1.1.17 (MC 26.2).zip`) must match `vt:afk-display`. Missing packs must fail before any world folder is created. Tested in Task 7.

---

## File Structure

```
package.json                         workspace root: scripts, dev deps
tsconfig.json                        one strict config for all packages
bun.lock                             committed
packages/profile/
  package.json
  src/index.ts                       re-exports + USER_AGENT
  src/errors.ts                      UserError
  src/schema.ts                      zod profile schema, parseProfile, toMegabytes
  src/hash.ts                        sha256Hex, sha512Hex (WebCrypto)
  src/http.ts                        getJson with retry/backoff, Fetch type
  src/modrinth.ts                    Modrinth API types + client
  src/fabric.ts                      Fabric meta client, chooseLoader, serverLauncherUrl
  src/mojang.ts                      Mojang manifest client (Java major version)
  src/select.ts                      pickVersion, primaryFile
  src/placement.ts                   Placement lattice, side mapping
  src/lockfile.ts                    Lockfile types, serialize/parse, profileHash
  src/resolve.ts                     resolveProfile, checkWaiting, checkAvailability
  src/mrpack.ts                      mrpackIndex, buildMrpack, isVanillaCompatible
  test/helpers.ts                    routeFetch, testHttp
  test/fakes.ts                      FakeModrinth, fakeFabric, fakeMojang, makeVersion, dep, makeProfile
  test/*.test.ts
  test/live.test.ts                  LIVE=1 only
apps/agent/
  package.json
  src/paths.ts                       cacheDir, configDir
  src/download.ts                    fetchVerified (content cache)
  src/server/properties.ts           mergeProperties
  src/server/packs.ts                packNameFromFilename, matchPacks
  src/server/build.ts                buildServer, ServerMarker, readMarker
  src/run/java.ts                    parseJavaMajor, javaMajor
  src/run/config.ts                  readConfig, writeConfig
  src/run/eula.ts                    ensureEula
  src/run/crash.ts                   suspectMod, crashSummary
  src/run/server.ts                  runServer
  src/commands.ts                    loadProfile, loadLock, cmd* and runCommand
  src/cli.ts                         parseCommand, main
  test/*.test.ts
profiles/
  vanilla-plus.json, vanilla-plus.lock.json
  adventure.json, adventure.lock.json
infra/tailscale/policy.hujson        + udp:24454
```

---

### Task 1: Workspace and profile schema

**Files:**
- Create: `package.json`, `tsconfig.json`, `packages/profile/package.json`, `packages/profile/src/errors.ts`, `packages/profile/src/schema.ts`, `packages/profile/src/index.ts`
- Test: `packages/profile/test/schema.test.ts`

**Interfaces:**
- Produces:
  - `class UserError extends Error`
  - `SIDES`
  - `type Side = "server" | "both" | "client-optional"`
  - `ProfileSchema`
  - `type Profile`
  - `type ModEntry`
  - `parseProfile(data: unknown, source: string): Profile`, which throws `UserError`
  - `toMegabytes(size: string): number`

- [ ] **Step 1: Create the workspace files**

`package.json`:
```json
{
  "name": "minecraft-discord-bot",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc -p ."
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.9.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun"],
    "lib": ["ESNext"]
  },
  "include": ["packages/*/src", "packages/*/test", "apps/*/src", "apps/*/test"]
}
```

`packages/profile/package.json`:
```json
{
  "name": "@mc/profile",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "fflate": "^0.8.2",
    "zod": "^4.1.0"
  }
}
```

Run: `bun install`
Expected: creates `bun.lock` and `node_modules/`, which is already gitignored.

- [ ] **Step 2: Write the failing test**

`packages/profile/test/schema.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { parseProfile, toMegabytes } from "../src/schema";

const base = {
  name: "test",
  description: "t",
  minecraft: "26.3",
  loader: { fabric: "latest-stable" },
  memory: { min: "2G", max: "4G" },
  mods: [{ modrinth: "lithium", side: "server" }],
};

describe("parseProfile", () => {
  test("accepts a minimal profile and fills defaults", () => {
    const p = parseProfile(base, "test.json");
    expect(p.waiting).toEqual([]);
    expect(p.datapacks).toEqual([]);
    expect(p.properties).toEqual({});
    expect(p.resourcePack).toBeUndefined();
  });

  test("reports a bad side with its path and the file name", () => {
    const bad = { ...base, mods: [{ modrinth: "lithium", side: "client" }] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/test\.json has problems[\s\S]*mods\.0\.side/);
  });

  test("rejects unknown keys such as a typo", () => {
    expect(() => parseProfile({ ...base, mod: [] }, "test.json")).toThrow(/Unrecognized key/);
  });

  test("rejects a mod listed twice", () => {
    const bad = { ...base, mods: [base.mods[0], base.mods[0]] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/"lithium" is listed twice/);
  });

  test("rejects a mod that is in both mods and waiting", () => {
    expect(() => parseProfile({ ...base, waiting: ["lithium"] }, "test.json")).toThrow(/both "mods" and "waiting"/);
  });

  test("rejects clientOptional on a side other than both", () => {
    const bad = { ...base, mods: [{ modrinth: "lithium", side: "server", clientOptional: true }] };
    expect(() => parseProfile(bad, "test.json")).toThrow(/mods\.0\.clientOptional/);
  });

  test("rejects min memory larger than max", () => {
    expect(() => parseProfile({ ...base, memory: { min: "8G", max: "4G" } }, "test.json")).toThrow(/memory\.min/);
  });

  test("rejects a bad datapack id", () => {
    expect(() => parseProfile({ ...base, datapacks: ["AFK Display"] }, "test.json")).toThrow(/datapacks\.0/);
  });
});

test("toMegabytes", () => {
  expect(toMegabytes("2G")).toBe(2048);
  expect(toMegabytes("512M")).toBe(512);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/profile/test/schema.test.ts`
Expected: FAIL, because `../src/schema` can't be resolved.

- [ ] **Step 4: Write the implementation**

`packages/profile/src/errors.ts`:
```ts
/** An error written for the person running the tool. The CLI prints only its message. */
export class UserError extends Error {
  override name = "UserError";
}
```

`packages/profile/src/schema.ts`:
```ts
import { z } from "zod";
import { UserError } from "./errors";

export const SIDES = ["server", "both", "client-optional"] as const;
export type Side = (typeof SIDES)[number];

const slug = z.string().regex(/^[a-z0-9._-]+$/, 'must be a Modrinth slug like "lithium"');
const memorySize = z.string().regex(/^\d+[MG]$/, 'must look like "2G" or "512M"');
const packId = z.string().regex(/^[a-z0-9]+:[a-z0-9-]+$/, 'must look like "vt:afk-display"');

const ModEntrySchema = z.strictObject({
  modrinth: slug,
  side: z.enum(SIDES),
  clientOptional: z.boolean().optional(),
  version: z.string().min(1).optional(),
});

export const ProfileSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9-]+$/, "must be lowercase letters, digits and dashes"),
    description: z.string(),
    minecraft: z.string().regex(/^\d+\.\d+(\.\d+)?$/, 'must be a release version like "26.3"'),
    loader: z.strictObject({
      fabric: z.union([z.literal("latest-stable"), z.string().regex(/^\d+\.\d+\.\d+$/)]),
    }),
    memory: z.strictObject({ min: memorySize, max: memorySize }),
    properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    mods: z.array(ModEntrySchema).min(1),
    waiting: z.array(slug).default([]),
    datapacks: z.array(packId).default([]),
    resourcePack: z.strictObject({ pack: packId, require: z.boolean().default(false) }).optional(),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.mods.forEach((m, i) => {
      if (seen.has(m.modrinth)) {
        ctx.addIssue({ code: "custom", path: ["mods", i, "modrinth"], message: `"${m.modrinth}" is listed twice` });
      }
      seen.add(m.modrinth);
      if (m.clientOptional !== undefined && m.side !== "both") {
        ctx.addIssue({ code: "custom", path: ["mods", i, "clientOptional"], message: 'only works with side "both"' });
      }
    });
    p.waiting.forEach((w, i) => {
      if (seen.has(w)) {
        ctx.addIssue({ code: "custom", path: ["waiting", i], message: `"${w}" is in both "mods" and "waiting"` });
      }
    });
    if (toMegabytes(p.memory.min) > toMegabytes(p.memory.max)) {
      ctx.addIssue({ code: "custom", path: ["memory", "min"], message: "is larger than memory.max" });
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;
export type ModEntry = Profile["mods"][number];

export function toMegabytes(size: string): number {
  const n = Number.parseInt(size, 10);
  return size.endsWith("G") ? n * 1024 : n;
}

export function parseProfile(data: unknown, source: string): Profile {
  const result = ProfileSchema.safeParse(data);
  if (result.success) return result.data;
  const lines = result.error.issues.map(
    (i) => `  ${i.path.length ? i.path.join(".") : "(top level)"}: ${i.message}`,
  );
  throw new UserError(`${source} has problems:\n${lines.join("\n")}`);
}
```

`packages/profile/src/index.ts`:
```ts
export * from "./errors";
export * from "./schema";

export const USER_AGENT =
  "alexvtejeda/minecraft-discord-bot/0.1.0 (github.com/alexvtejeda/minecraft-discord-bot)";
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test packages/profile/test/schema.test.ts && bun run typecheck`
Expected: 9 tests pass and tsc reports no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json bun.lock packages/profile
git commit -m "feat(profile): workspace and profile schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: HTTP helper and API clients (Modrinth, Fabric meta, Mojang)

**Files:**
- Create: `packages/profile/src/hash.ts`, `packages/profile/src/http.ts`, `packages/profile/src/modrinth.ts`, `packages/profile/src/fabric.ts`, `packages/profile/src/mojang.ts`, `packages/profile/test/helpers.ts`
- Modify: `packages/profile/src/index.ts`
- Test: `packages/profile/test/http.test.ts`, `packages/profile/test/clients.test.ts`

**Interfaces:**
- Consumes: `UserError` (Task 1).
- Produces:
  - `sha256Hex(data: Uint8Array | string): Promise<string>`
  - `sha512Hex(data: Uint8Array): Promise<string>`
  - `type Fetch = (input: string, init?: RequestInit) => Promise<Response>`
  - `interface Http { fetch: Fetch; userAgent: string; sleep?: (ms: number) => Promise<void>; maxAttempts?: number }`
  - `getJson<T>(http: Http, url: string): Promise<T | null>`
  - Modrinth types `SideSupport`, `MrProject`, `MrFile`, `MrDependency`, `MrVersion`
  - `interface ModrinthClient { getProject(ref: string): Promise<MrProject | null>; getVersions(projectId: string, minecraft: string): Promise<MrVersion[]>; getVersion(versionId: string): Promise<MrVersion | null>; searchSlug(query: string): Promise<string | null> }`
  - `createModrinthClient(http: Http, base?: string): ModrinthClient`
  - `interface FabricMeta { loaderVersions(minecraft: string): Promise<{ version: string; stable: boolean }[]>; latestStableInstaller(): Promise<string> }`
  - `createFabricMeta(http: Http, base?: string): FabricMeta`
  - `chooseLoader(meta: FabricMeta, minecraft: string, wanted: string): Promise<string>`
  - `serverLauncherUrl(minecraft: string, loader: string, installer: string): string`
  - `interface MojangMeta { javaMajor(minecraft: string): Promise<number> }`
  - `createMojangMeta(http: Http, manifestUrl?: string): MojangMeta`
  - Test helpers `routeFetch(routes: Record<string, unknown>)` returning `{ fetch: Fetch; calls: { url: string; init?: RequestInit }[] }`, and `testHttp(fetch: Fetch): Http`

- [ ] **Step 1: Write the test helpers**

`packages/profile/test/helpers.ts`:
```ts
import type { Fetch, Http } from "../src/http";

/** A fetch that answers from a URL → JSON body map. Unknown URLs get 404. */
export function routeFetch(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (!(url in routes)) return new Response("not found", { status: 404 });
    return Response.json(routes[url]);
  };
  return { fetch, calls };
}

export function testHttp(fetch: Fetch): Http {
  return { fetch, userAgent: "test-agent", sleep: async () => {} };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/profile/test/http.test.ts`:
```ts
import { expect, test } from "bun:test";
import { UserError } from "../src/errors";
import { sha256Hex, sha512Hex } from "../src/hash";
import { getJson, type Fetch } from "../src/http";

function sequence(items: (Response | Error)[]) {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const fetch: Fetch = async (url, init) => {
    urls.push(url);
    headers.push(new Headers(init?.headers));
    const next = items.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, urls, headers };
}

test("returns parsed JSON and sends the User-Agent", async () => {
  const s = sequence([Response.json({ ok: 1 })]);
  const data = await getJson<{ ok: number }>({ fetch: s.fetch, userAgent: "ua/1" }, "https://x.test/a");
  expect(data).toEqual({ ok: 1 });
  expect(s.headers[0]!.get("User-Agent")).toBe("ua/1");
});

test("returns null on 404", async () => {
  const s = sequence([new Response("", { status: 404 })]);
  expect(await getJson({ fetch: s.fetch, userAgent: "ua" }, "https://x.test/a")).toBeNull();
});

test("waits for X-Ratelimit-Reset on 429, then succeeds", async () => {
  const waits: number[] = [];
  const s = sequence([
    new Response("", { status: 429, headers: { "X-Ratelimit-Reset": "3" } }),
    Response.json([1]),
  ]);
  const data = await getJson(
    { fetch: s.fetch, userAgent: "ua", sleep: async (ms) => void waits.push(ms) },
    "https://x.test/a",
  );
  expect(data).toEqual([1]);
  expect(waits).toEqual([3000]);
});

test("retries a network error", async () => {
  const s = sequence([new Error("ECONNRESET"), Response.json("fine")]);
  const data = await getJson({ fetch: s.fetch, userAgent: "ua", sleep: async () => {} }, "https://x.test/a");
  expect(data).toBe("fine");
});

test("gives up after maxAttempts with a plain-English UserError", async () => {
  const s = sequence([503, 503, 503].map((status) => new Response("", { status })));
  const p = getJson({ fetch: s.fetch, userAgent: "ua", sleep: async () => {}, maxAttempts: 3 }, "https://api.x.test/a");
  await expect(p).rejects.toBeInstanceOf(UserError);
  await expect(p).rejects.toThrow(/api\.x\.test isn't responding \(HTTP 503\)\. Try again in a few minutes\./);
});

test("does not retry other 4xx errors", async () => {
  const s = sequence([new Response("", { status: 400 })]);
  await expect(getJson({ fetch: s.fetch, userAgent: "ua" }, "https://x.test/a")).rejects.toThrow(/HTTP 400/);
  expect(s.urls.length).toBe(1);
});

test("hash helpers", async () => {
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect((await sha512Hex(new TextEncoder().encode("abc"))).slice(0, 16)).toBe("ddaf35a193617aba");
});
```

`packages/profile/test/clients.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { chooseLoader, createFabricMeta, serverLauncherUrl } from "../src/fabric";
import { createModrinthClient } from "../src/modrinth";
import { createMojangMeta } from "../src/mojang";
import { routeFetch, testHttp } from "./helpers";

const MR = "https://api.modrinth.com/v2";
const FABRIC = "https://meta.fabricmc.net/v2";

describe("modrinth client", () => {
  test("builds the version query for Fabric and one game version", async () => {
    const url = `${MR}/project/abc/version?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent('["26.3"]')}`;
    const { fetch, calls } = routeFetch({ [url]: [{ id: "v1" }] });
    const versions = await createModrinthClient(testHttp(fetch)).getVersions("abc", "26.3");
    expect(versions).toEqual([{ id: "v1" }] as never);
    expect(new Headers(calls[0]!.init?.headers).get("User-Agent")).toBe("test-agent");
  });

  test("getProject returns null for an unknown slug", async () => {
    const { fetch } = routeFetch({});
    expect(await createModrinthClient(testHttp(fetch)).getProject("nope")).toBeNull();
  });

  test("getVersions returns [] for an unknown project", async () => {
    const { fetch } = routeFetch({});
    expect(await createModrinthClient(testHttp(fetch)).getVersions("nope", "26.3")).toEqual([]);
  });

  test("searchSlug returns the first Fabric mod hit", async () => {
    const facets = encodeURIComponent(JSON.stringify([["categories:fabric"], ["project_type:mod"]]));
    const url = `${MR}/search?query=lithum&limit=1&facets=${facets}`;
    const { fetch } = routeFetch({ [url]: { hits: [{ slug: "lithium" }] } });
    expect(await createModrinthClient(testHttp(fetch)).searchSlug("lithum")).toBe("lithium");
  });
});

describe("fabric meta", () => {
  const routes = {
    [`${FABRIC}/versions/loader/26.3`]: [
      { loader: { version: "0.20.0-beta.1", stable: false } },
      { loader: { version: "0.19.5", stable: true } },
    ],
    [`${FABRIC}/versions/loader/9.9`]: [],
    [`${FABRIC}/versions/installer`]: [
      { version: "1.2.0-beta", stable: false },
      { version: "1.1.2", stable: true },
    ],
  };
  const meta = createFabricMeta(testHttp(routeFetch(routes).fetch));

  test("latest-stable skips unstable loaders", async () => {
    expect(await chooseLoader(meta, "26.3", "latest-stable")).toBe("0.19.5");
  });
  test("an exact loader must exist for that game version", async () => {
    expect(await chooseLoader(meta, "26.3", "0.19.5")).toBe("0.19.5");
    await expect(chooseLoader(meta, "26.3", "0.1.0")).rejects.toThrow(/Fabric loader 0\.1\.0 doesn't exist for Minecraft 26\.3/);
  });
  test("an unsupported game version gets a clear message", async () => {
    await expect(chooseLoader(meta, "9.9", "latest-stable")).rejects.toThrow(/Fabric doesn't support Minecraft 9\.9 yet/);
  });
  test("latest stable installer", async () => {
    expect(await meta.latestStableInstaller()).toBe("1.1.2");
  });
  test("server launcher url", () => {
    expect(serverLauncherUrl("26.3", "0.19.5", "1.1.2")).toBe(`${FABRIC}/versions/loader/26.3/0.19.5/1.1.2/server/jar`);
  });
});

describe("mojang meta", () => {
  const manifest = "https://mojang.test/manifest.json";
  const routes = {
    [manifest]: {
      versions: [
        { id: "26.4-snapshot-1", type: "snapshot", url: "https://mojang.test/snap.json" },
        { id: "26.3", type: "release", url: "https://mojang.test/26.3.json" },
      ],
    },
    "https://mojang.test/26.3.json": { javaVersion: { component: "java-runtime-epsilon", majorVersion: 25 } },
  };
  const mojang = createMojangMeta(testHttp(routeFetch(routes).fetch), manifest);

  test("reads the Java major version", async () => {
    expect(await mojang.javaMajor("26.3")).toBe(25);
  });
  test("rejects snapshots", async () => {
    await expect(mojang.javaMajor("26.4-snapshot-1")).rejects.toThrow(/is a snapshot, not a release/);
  });
  test("rejects unknown versions", async () => {
    await expect(mojang.javaMajor("99.1")).rejects.toThrow(/isn't in Mojang's version list/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/profile/test/http.test.ts packages/profile/test/clients.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 4: Write the implementation**

`packages/profile/src/hash.ts`:
```ts
function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Copying into a fresh Uint8Array gives an ArrayBuffer-backed view, which WebCrypto's
// BufferSource type requires (Node Buffers are typed as ArrayBufferLike).
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha512Hex(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-512", new Uint8Array(data)));
}
```

`packages/profile/src/http.ts`:
```ts
import { UserError } from "./errors";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Http {
  fetch: Fetch;
  userAgent: string;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number) => 500 * 2 ** attempt;

/** GET a JSON document. Returns null on 404. Retries 429, 5xx and network errors with backoff. */
export async function getJson<T>(http: Http, url: string): Promise<T | null> {
  const sleep = http.sleep ?? defaultSleep;
  const attempts = http.maxAttempts ?? 5;
  let last = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const isLast = attempt === attempts - 1;
    let res: Response;
    try {
      res = await http.fetch(url, { headers: { "User-Agent": http.userAgent, Accept: "application/json" } });
    } catch (err) {
      last = (err as Error).message;
      if (!isLast) await sleep(backoff(attempt));
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as T;
    last = `HTTP ${res.status}`;
    if (res.status !== 429 && res.status < 500) throw new Error(`GET ${url} failed: ${last}`);
    const reset = Number(res.headers.get("X-Ratelimit-Reset"));
    if (!isLast) await sleep(res.status === 429 && reset > 0 ? reset * 1000 : backoff(attempt));
  }
  throw new UserError(`${new URL(url).host} isn't responding (${last}). Try again in a few minutes.`);
}
```

`packages/profile/src/modrinth.ts`:
```ts
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
```

`packages/profile/src/fabric.ts`:
```ts
import { UserError } from "./errors";
import { getJson, type Http } from "./http";

const FABRIC_META = "https://meta.fabricmc.net/v2";

export interface FabricMeta {
  loaderVersions(minecraft: string): Promise<{ version: string; stable: boolean }[]>;
  latestStableInstaller(): Promise<string>;
}

export function createFabricMeta(http: Http, base = FABRIC_META): FabricMeta {
  return {
    async loaderVersions(minecraft) {
      const data = await getJson<{ loader: { version: string; stable: boolean } }[]>(
        http,
        `${base}/versions/loader/${encodeURIComponent(minecraft)}`,
      );
      return (data ?? []).map((d) => d.loader);
    },
    async latestStableInstaller() {
      const data = (await getJson<{ version: string; stable: boolean }[]>(http, `${base}/versions/installer`)) ?? [];
      const stable = data.find((d) => d.stable);
      if (!stable) throw new UserError("Fabric has no stable installer listed right now. Try again later.");
      return stable.version;
    },
  };
}

/** Resolve "latest-stable" or check that an exact loader version exists for this Minecraft version. */
export async function chooseLoader(meta: FabricMeta, minecraft: string, wanted: string): Promise<string> {
  const loaders = await meta.loaderVersions(minecraft);
  if (loaders.length === 0) {
    throw new UserError(`Fabric doesn't support Minecraft ${minecraft} yet. Pick another version or wait for Fabric to update.`);
  }
  if (wanted === "latest-stable") {
    const stable = loaders.find((l) => l.stable);
    if (!stable) throw new UserError(`Fabric has no stable loader for Minecraft ${minecraft} yet.`);
    return stable.version;
  }
  if (!loaders.some((l) => l.version === wanted)) {
    throw new UserError(
      `Fabric loader ${wanted} doesn't exist for Minecraft ${minecraft}. Use "latest-stable" or a version listed at https://fabricmc.net/develop/.`,
    );
  }
  return wanted;
}

export function serverLauncherUrl(minecraft: string, loader: string, installer: string): string {
  return `${FABRIC_META}/versions/loader/${minecraft}/${loader}/${installer}/server/jar`;
}
```

`packages/profile/src/mojang.ts`:
```ts
import { UserError } from "./errors";
import { getJson, type Http } from "./http";

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

export interface MojangMeta {
  javaMajor(minecraft: string): Promise<number>;
}

export function createMojangMeta(http: Http, manifestUrl = MANIFEST): MojangMeta {
  return {
    async javaMajor(minecraft) {
      const manifest = await getJson<{ versions: { id: string; type: string; url: string }[] }>(http, manifestUrl);
      const entry = manifest?.versions.find((v) => v.id === minecraft);
      if (!entry) throw new UserError(`Minecraft ${minecraft} isn't in Mojang's version list. Check the "minecraft" field.`);
      if (entry.type !== "release") {
        throw new UserError(`Minecraft ${minecraft} is a ${entry.type}, not a release. Profiles only use releases.`);
      }
      const detail = await getJson<{ javaVersion?: { majorVersion: number } }>(http, entry.url);
      const major = detail?.javaVersion?.majorVersion;
      if (!major) throw new UserError(`Mojang's metadata for ${minecraft} doesn't say which Java it needs.`);
      return major;
    },
  };
}
```

Append these lines to `packages/profile/src/index.ts` (before `USER_AGENT`):
```ts
export * from "./hash";
export * from "./http";
export * from "./modrinth";
export * from "./fabric";
export * from "./mojang";
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test packages/profile && bun run typecheck`
Expected: every test passes, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/profile
git commit -m "feat(profile): http retry helper and Modrinth, Fabric, Mojang clients

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Version selection and side placement

**Files:**
- Create: `packages/profile/src/select.ts`, `packages/profile/src/placement.ts`, `packages/profile/test/fakes.ts`
- Modify: `packages/profile/src/index.ts`
- Test: `packages/profile/test/select.test.ts`, `packages/profile/test/placement.test.ts`

**Interfaces:**
- Consumes: `MrVersion`, `MrFile`, `MrProject`, `MrDependency`, `ModrinthClient`, `FabricMeta`, `MojangMeta` (Task 2); `Side`, `Profile` and `parseProfile` (Task 1).
- Produces:
  - `pickVersion(versions: MrVersion[], pin?: string): MrVersion | null`
  - `primaryFile(version: MrVersion, title: string): MrFile`
  - `type ClientNeed = "no" | "optional" | "required"`
  - `interface Placement { server: boolean; client: ClientNeed }`
  - `placementOf(side: Side, clientOptional?: boolean): Placement`
  - `mergePlacement(a: Placement, b: Placement): Placement`
  - `samePlacement(a: Placement, b: Placement): boolean`
  - `clampToProject(p: Placement, project: MrProject): Placement`
  - `sideOf(p: Placement): { side: Side; clientOptional: boolean }`
  - `sideFromMetadata(project: MrProject): Side`
  - Test fakes `FakeModrinth`, `makeVersion`, `dep`, `fakeFabric`, `fakeMojang`, `makeProfile`

- [ ] **Step 1: Write the shared fakes** (used by this task and by Tasks 4, 5 and 9)

`packages/profile/test/fakes.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing tests**

`packages/profile/test/select.test.ts`:
```ts
import { expect, test } from "bun:test";
import { pickVersion, primaryFile } from "../src/select";
import { makeVersion } from "./fakes";

const v = (id: string, type: "release" | "beta" | "alpha", date: string) =>
  makeVersion("P", { id, version_type: type, date_published: date });

test("prefers the newest release over a newer beta", () => {
  const picked = pickVersion([v("b2", "beta", "2026-09-10T00:00:00Z"), v("r1", "release", "2026-09-01T00:00:00Z"), v("r0", "release", "2026-08-01T00:00:00Z")]);
  expect(picked?.id).toBe("r1");
});

test("falls back to beta, then alpha", () => {
  expect(pickVersion([v("a1", "alpha", "2026-09-10T00:00:00Z"), v("b1", "beta", "2026-09-01T00:00:00Z")])?.id).toBe("b1");
  expect(pickVersion([v("a1", "alpha", "2026-09-10T00:00:00Z")])?.id).toBe("a1");
});

test("a pin matches version_number or id, even if not newest", () => {
  const list = [v("r2", "release", "2026-09-10T00:00:00Z"), makeVersion("P", { id: "abc123", version_number: "26.3-11.4.0" })];
  expect(pickVersion(list, "26.3-11.4.0")?.id).toBe("abc123");
  expect(pickVersion(list, "abc123")?.id).toBe("abc123");
  expect(pickVersion(list, "nope")).toBeNull();
});

test("ignores versions that are not for Fabric", () => {
  expect(pickVersion([makeVersion("P", { id: "q", loaders: ["quilt"] })])).toBeNull();
});

test("returns null for no versions", () => {
  expect(pickVersion([])).toBeNull();
});

test("primaryFile prefers the primary file and errors when there is none", () => {
  const ver = makeVersion("P", { id: "x" });
  ver.files = [{ ...ver.files[0]!, filename: "sources.jar", primary: false }, { ...ver.files[0]!, filename: "main.jar", primary: true }];
  expect(primaryFile(ver, "Mod").filename).toBe("main.jar");
  expect(() => primaryFile({ ...ver, files: [] }, "Mod")).toThrow(/Mod x has no downloadable file/);
});
```

`packages/profile/test/placement.test.ts`:
```ts
import { expect, test } from "bun:test";
import type { MrProject } from "../src/modrinth";
import { clampToProject, mergePlacement, placementOf, sideFromMetadata, sideOf } from "../src/placement";

const project = (client_side: MrProject["client_side"], server_side: MrProject["server_side"]): MrProject => ({
  id: "P",
  slug: "p",
  title: "P",
  client_side,
  server_side,
});

test("placementOf and sideOf round-trip", () => {
  expect(sideOf(placementOf("server"))).toEqual({ side: "server", clientOptional: false });
  expect(sideOf(placementOf("both"))).toEqual({ side: "both", clientOptional: false });
  expect(sideOf(placementOf("both", true))).toEqual({ side: "both", clientOptional: true });
  expect(sideOf(placementOf("client-optional"))).toEqual({ side: "client-optional", clientOptional: false });
});

test("merge widens: server + both(required) = both required", () => {
  expect(sideOf(mergePlacement(placementOf("server"), placementOf("both")))).toEqual({ side: "both", clientOptional: false });
});

test("merge: server + client-optional = both, optional on the client", () => {
  expect(sideOf(mergePlacement(placementOf("server"), placementOf("client-optional")))).toEqual({ side: "both", clientOptional: true });
});

test("merge: optional + required on the client = required", () => {
  expect(sideOf(mergePlacement(placementOf("both", true), placementOf("both")))).toEqual({ side: "both", clientOptional: false });
});

test("clampToProject keeps a server-only library off clients", () => {
  const clamped = clampToProject(placementOf("both"), project("unsupported", "required"));
  expect(sideOf(clamped)).toEqual({ side: "server", clientOptional: false });
});

test("clampToProject keeps a client-only library off the server", () => {
  const clamped = clampToProject(placementOf("both", true), project("required", "unsupported"));
  expect(sideOf(clamped)).toEqual({ side: "client-optional", clientOptional: false });
});

test("sideFromMetadata", () => {
  expect(sideFromMetadata(project("required", "unsupported"))).toBe("client-optional");
  expect(sideFromMetadata(project("required", "required"))).toBe("both");
  expect(sideFromMetadata(project("optional", "required"))).toBe("server");
  expect(sideFromMetadata(project("unsupported", "required"))).toBe("server");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/profile/test/select.test.ts packages/profile/test/placement.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 4: Write the implementation**

`packages/profile/src/select.ts`:
```ts
import { UserError } from "./errors";
import type { MrFile, MrVersion } from "./modrinth";

/** Newest release, else newest beta, else newest alpha. A pin matches version_number or id. */
export function pickVersion(versions: MrVersion[], pin?: string): MrVersion | null {
  const fabric = versions.filter((v) => v.loaders.includes("fabric"));
  if (pin) return fabric.find((v) => v.version_number === pin || v.id === pin) ?? null;
  const newest = [...fabric].sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published));
  for (const type of ["release", "beta", "alpha"] as const) {
    const hit = newest.find((v) => v.version_type === type);
    if (hit) return hit;
  }
  return null;
}

export function primaryFile(version: MrVersion, title: string): MrFile {
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) throw new UserError(`${title} ${version.version_number} has no downloadable file on Modrinth.`);
  return file;
}
```

`packages/profile/src/placement.ts`:
```ts
import type { MrProject } from "./modrinth";
import type { Side } from "./schema";

export type ClientNeed = "no" | "optional" | "required";

/** Where a file goes: on the server or not, and how much the client needs it. */
export interface Placement {
  server: boolean;
  client: ClientNeed;
}

const RANK: Record<ClientNeed, number> = { no: 0, optional: 1, required: 2 };

export function placementOf(side: Side, clientOptional = false): Placement {
  switch (side) {
    case "server":
      return { server: true, client: "no" };
    case "both":
      return { server: true, client: clientOptional ? "optional" : "required" };
    case "client-optional":
      return { server: false, client: "optional" };
  }
}

/** The widest of two placements: on the server if either needs it, and the stronger client need. */
export function mergePlacement(a: Placement, b: Placement): Placement {
  return { server: a.server || b.server, client: RANK[a.client] >= RANK[b.client] ? a.client : b.client };
}

export function samePlacement(a: Placement, b: Placement): boolean {
  return a.server === b.server && a.client === b.client;
}

/** Never place a file on a side its Modrinth metadata says it doesn't support. */
export function clampToProject(p: Placement, project: MrProject): Placement {
  return {
    server: p.server && project.server_side !== "unsupported",
    client: project.client_side === "unsupported" ? "no" : p.client,
  };
}

export function sideOf(p: Placement): { side: Side; clientOptional: boolean } {
  if (!p.server) return { side: "client-optional", clientOptional: false };
  if (p.client === "no") return { side: "server", clientOptional: false };
  return { side: "both", clientOptional: p.client === "optional" };
}

/** Best guess of a side for a mod added from "waiting", from its Modrinth metadata. */
export function sideFromMetadata(project: MrProject): Side {
  if (project.server_side === "unsupported") return "client-optional";
  if (project.client_side === "required") return "both";
  return "server";
}
```

Append to `packages/profile/src/index.ts` (before `USER_AGENT`):
```ts
export * from "./select";
export * from "./placement";
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test packages/profile && bun run typecheck`
Expected: every test passes, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/profile
git commit -m "feat(profile): version selection and side placement rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Lockfile format and resolver

**Files:**
- Create: `packages/profile/src/lockfile.ts`, `packages/profile/src/resolve.ts`
- Modify: `packages/profile/src/index.ts`
- Test: `packages/profile/test/resolve.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 3.
- Produces:
  - `interface LockEntry { slug: string; projectId: string; versionId: string; versionNumber: string; filename: string; url: string; sha1: string; sha512: string; size: number; side: Side; clientOptional: boolean; auto: boolean; prerelease: boolean }`
  - `interface Lockfile { lockfileVersion: 1; profile: string; profileHash: string; minecraft: string; javaMajor: number; fabricLoader: string; fabricInstaller: string; files: LockEntry[] }`
  - `serializeLock(lock: Lockfile): string`
  - `parseLock(text: string, source: string): Lockfile`
  - `profileHash(profile: Profile): Promise<string>`
  - `interface ResolveDeps { modrinth: ModrinthClient; fabric: FabricMeta; mojang: MojangMeta }`
  - `interface WaitingStatus { slug: string; ready: boolean; suggestedSide?: Side }`
  - `interface ResolveResult { lock: Lockfile; warnings: string[]; waiting: WaitingStatus[] }`
  - `resolveProfile(profile: Profile, deps: ResolveDeps): Promise<ResolveResult>`
  - `checkWaiting(profile: Profile, modrinth: ModrinthClient): Promise<{ statuses: WaitingStatus[]; warnings: string[] }>`
  - `checkAvailability(profile: Profile, minecraft: string, modrinth: ModrinthClient): Promise<{ slug: string; available: boolean; waiting: boolean }[]>`

- [ ] **Step 1: Write the failing tests**

`packages/profile/test/resolve.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { parseLock, serializeLock } from "../src/lockfile";
import { checkAvailability, resolveProfile, type ResolveDeps } from "../src/resolve";
import { dep, FakeModrinth, fakeFabric, fakeMojang, makeProfile } from "./fakes";

function deps(mr: FakeModrinth): ResolveDeps {
  return { modrinth: mr, fabric: fakeFabric, mojang: fakeMojang };
}

describe("resolveProfile", () => {
  test("pins loader, installer, java and each file with its side", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium", [{}], { client: "optional", server: "optional" });
    mr.add("sodium", [{}], { client: "required", server: "unsupported" });
    const profile = makeProfile({
      mods: [
        { modrinth: "sodium", side: "client-optional" },
        { modrinth: "lithium", side: "server" },
      ],
    });
    const { lock, warnings } = await resolveProfile(profile, deps(mr));
    expect(lock.fabricLoader).toBe("0.19.5");
    expect(lock.fabricInstaller).toBe("1.1.2");
    expect(lock.javaMajor).toBe(25);
    expect(lock.profileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(warnings).toEqual([]);
    expect(lock.files.map((f) => [f.slug, f.side, f.auto])).toEqual([
      ["lithium", "server", false],
      ["sodium", "client-optional", false],
    ]);
    expect(lock.files[0]).toMatchObject({
      projectId: "LITHIUM",
      versionId: "lithium-v1",
      filename: "LITHIUM-lithium-v1.jar",
      sha512: "sha512-lithium-v1",
      prerelease: false,
    });
  });

  test("a prerelease-only mod resolves with a warning and a flag", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium", [{ version_type: "beta", version_number: "0.9-beta" }]);
    const { lock, warnings } = await resolveProfile(makeProfile(), deps(mr));
    expect(lock.files[0]!.prerelease).toBe(true);
    expect(warnings[0]).toMatch(/lithium: only a beta build exists for Minecraft 26\.3, using 0\.9-beta/);
  });

  test("unknown slug suggests the closest match", async () => {
    const mr = new FakeModrinth();
    mr.searches.set("lithum", "lithium");
    const profile = makeProfile({ mods: [{ modrinth: "lithum", side: "server" }] });
    await expect(resolveProfile(profile, deps(mr))).rejects.toThrow('No mod called "lithum" on Modrinth. Did you mean "lithium"?');
  });

  test("a mod with no build for the version suggests waiting", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium", [{ game_versions: ["26.2"] }]);
    await expect(resolveProfile(makeProfile(), deps(mr))).rejects.toThrow(/has no Fabric build for Minecraft 26\.3 yet\. Move "lithium" to "waiting"/);
  });

  test("honors a version pin", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium", [
      { version_number: "new", date_published: "2026-09-20T00:00:00Z" },
      { version_number: "old", date_published: "2026-09-01T00:00:00Z" },
    ]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "lithium", side: "server", version: "old" }] }), deps(mr));
    expect(lock.files[0]!.versionNumber).toBe("old");
  });

  test("pulls in required dependencies and marks them auto", async () => {
    const mr = new FakeModrinth();
    const balm = mr.add("balm");
    mr.add("waystones", [{ dependencies: [dep(balm), dep("OPTIONAL-THING", "optional")] }]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "waystones", side: "both" }] }), deps(mr));
    expect(lock.files.map((f) => [f.slug, f.side, f.auto])).toEqual([
      ["balm", "both", true],
      ["waystones", "both", false],
    ]);
  });

  // Review focus 1
  test("a library listed as server becomes required on the client when a both mod needs it", async () => {
    const mr = new FakeModrinth();
    const api = mr.add("fabric-api", [{}], { client: "optional", server: "optional" });
    mr.add("waystones", [{ dependencies: [dep(api)] }]);
    const profile = makeProfile({
      mods: [
        { modrinth: "fabric-api", side: "server" },
        { modrinth: "waystones", side: "both" },
      ],
    });
    const { lock } = await resolveProfile(profile, deps(mr));
    const api_ = lock.files.find((f) => f.slug === "fabric-api")!;
    expect(api_).toMatchObject({ side: "both", clientOptional: false, auto: false });
  });

  test("a server library needed by a client-optional mod becomes both, optional on the client", async () => {
    const mr = new FakeModrinth();
    const api = mr.add("fabric-api", [{}], { client: "optional", server: "optional" });
    mr.add("modmenu", [{ dependencies: [dep(api)] }], { client: "required", server: "unsupported" });
    const profile = makeProfile({
      mods: [
        { modrinth: "fabric-api", side: "server" },
        { modrinth: "modmenu", side: "client-optional" },
      ],
    });
    const { lock } = await resolveProfile(profile, deps(mr));
    expect(lock.files.find((f) => f.slug === "fabric-api")).toMatchObject({ side: "both", clientOptional: true });
  });

  // Review focus 2
  test("a server-only dependency of a both mod is never sent to clients", async () => {
    const mr = new FakeModrinth();
    const lib = mr.add("server-lib", [{}], { client: "unsupported", server: "required" });
    mr.add("waystones", [{ dependencies: [dep(lib)] }]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "waystones", side: "both" }] }), deps(mr));
    expect(lock.files.find((f) => f.slug === "server-lib")).toMatchObject({ side: "server", auto: true });
  });

  test("a dependency pinned by version id is fetched directly", async () => {
    const mr = new FakeModrinth();
    const lib = mr.add("lib", [{ id: "lib-exact", game_versions: ["26.3-pre-1"] }]);
    mr.add("waystones", [{ dependencies: [{ project_id: lib, version_id: "lib-exact", file_name: null, dependency_type: "required" }] }]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "waystones", side: "both" }] }), deps(mr));
    expect(lock.files.find((f) => f.slug === "lib")!.versionId).toBe("lib-exact");
  });

  test("a dependency cycle terminates", async () => {
    const mr = new FakeModrinth();
    mr.add("a", [{ dependencies: [dep("B")] }]);
    mr.add("b", [{ dependencies: [dep("A")] }]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "a", side: "both" }] }), deps(mr));
    expect(lock.files.map((f) => f.slug)).toEqual(["a", "b"]);
  });

  test("incompatible mods fail and name both", async () => {
    const mr = new FakeModrinth();
    const b = mr.add("optifabric");
    mr.add("sodium", [{ dependencies: [dep(b, "incompatible")] }]);
    const profile = makeProfile({
      mods: [
        { modrinth: "sodium", side: "client-optional" },
        { modrinth: "optifabric", side: "client-optional" },
      ],
    });
    await expect(resolveProfile(profile, deps(mr))).rejects.toThrow(/sodium and optifabric don't work together/);
  });

  test("an incompatible mod that is not in the profile is fine", async () => {
    const mr = new FakeModrinth();
    mr.add("sodium", [{ dependencies: [dep("NOT-HERE", "incompatible")] }]);
    await expect(resolveProfile(makeProfile({ mods: [{ modrinth: "sodium", side: "client-optional" }] }), deps(mr))).resolves.toBeDefined();
  });

  test("a dependency that is not on Modrinth fails with advice", async () => {
    const mr = new FakeModrinth();
    mr.add("waystones", [{ dependencies: [{ project_id: null, version_id: null, file_name: "secret-lib.jar", dependency_type: "required" }] }]);
    await expect(resolveProfile(makeProfile({ mods: [{ modrinth: "waystones", side: "both" }] }), deps(mr))).rejects.toThrow(
      /waystones needs "secret-lib\.jar", which isn't on Modrinth/,
    );
  });

  test("reports waiting mods and suggests a side for ready ones", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium");
    mr.add("lootr", [{}], { client: "required", server: "required" });
    mr.add("carry-on", [{ game_versions: ["26.2"] }]);
    const { waiting, warnings } = await resolveProfile(makeProfile({ waiting: ["lootr", "carry-on", "ghost"] }), deps(mr));
    expect(waiting).toEqual([
      { slug: "lootr", ready: true, suggestedSide: "both" },
      { slug: "carry-on", ready: false },
      { slug: "ghost", ready: false },
    ]);
    expect(warnings).toContain('Waiting mod "ghost" isn\'t on Modrinth. Check the spelling.');
  });

  test("the lockfile is deterministic and round-trips", async () => {
    const mr = new FakeModrinth();
    mr.add("zeta");
    mr.add("alpha");
    const profile = makeProfile({ mods: [{ modrinth: "zeta", side: "server" }, { modrinth: "alpha", side: "server" }] });
    const a = serializeLock((await resolveProfile(profile, deps(mr))).lock);
    const b = serializeLock((await resolveProfile(profile, deps(mr))).lock);
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    expect(parseLock(a, "x.lock.json").files.map((f) => f.slug)).toEqual(["alpha", "zeta"]);
  });
});

test("parseLock rejects garbage with advice", () => {
  expect(() => parseLock("{", "x.lock.json")).toThrow(/x\.lock\.json isn't valid JSON/);
  expect(() => parseLock('{"lockfileVersion":2,"files":[]}', "x.lock.json")).toThrow(/Run "mc-host profile resolve" again/);
});

test("checkAvailability reports every mod and waiting mod for another version", async () => {
  const mr = new FakeModrinth();
  mr.add("lithium", [{ game_versions: ["26.3", "26.2"] }]);
  mr.add("lootr", [{ game_versions: ["26.2"] }]);
  const report = await checkAvailability(makeProfile({ waiting: ["lootr", "ghost"] }), "26.2", mr);
  expect(report).toEqual([
    { slug: "lithium", available: true, waiting: false },
    { slug: "lootr", available: true, waiting: true },
    { slug: "ghost", available: false, waiting: true },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/profile/test/resolve.test.ts`
Expected: FAIL, because `../src/lockfile` and `../src/resolve` can't be resolved.

- [ ] **Step 3: Write `lockfile.ts`**

`packages/profile/src/lockfile.ts`:
```ts
import { UserError } from "./errors";
import { sha256Hex } from "./hash";
import type { Profile, Side } from "./schema";

export interface LockEntry {
  slug: string;
  projectId: string;
  versionId: string;
  versionNumber: string;
  filename: string;
  url: string;
  sha1: string;
  sha512: string;
  size: number;
  side: Side;
  clientOptional: boolean;
  /** Pulled in as a dependency, not listed in the profile. */
  auto: boolean;
  /** Only a beta or alpha build was available. */
  prerelease: boolean;
}

export interface Lockfile {
  lockfileVersion: 1;
  profile: string;
  /** sha256 of the parsed profile. Build commands refuse a lockfile whose hash doesn't match. */
  profileHash: string;
  minecraft: string;
  javaMajor: number;
  fabricLoader: string;
  fabricInstaller: string;
  files: LockEntry[];
}

export function serializeLock(lock: Lockfile): string {
  return JSON.stringify(lock, null, 2) + "\n";
}

export function parseLock(text: string, source: string): Lockfile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UserError(`${source} isn't valid JSON. Delete it and run "mc-host profile resolve" again.`);
  }
  const lock = data as Partial<Lockfile> | null;
  if (!lock || lock.lockfileVersion !== 1 || !Array.isArray(lock.files)) {
    throw new UserError(`${source} isn't a lockfile this version of mc-host understands. Run "mc-host profile resolve" again.`);
  }
  return lock as Lockfile;
}

export function profileHash(profile: Profile): Promise<string> {
  return sha256Hex(JSON.stringify(profile));
}
```

- [ ] **Step 4: Write `resolve.ts`**

`packages/profile/src/resolve.ts`:
```ts
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
```

Append to `packages/profile/src/index.ts` (before `USER_AGENT`):
```ts
export * from "./lockfile";
export * from "./resolve";
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test packages/profile && bun run typecheck`
Expected: every test passes, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/profile
git commit -m "feat(profile): lockfile format and dependency resolver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `.mrpack` builder

**Files:**
- Create: `packages/profile/src/mrpack.ts`
- Modify: `packages/profile/src/index.ts`
- Test: `packages/profile/test/mrpack.test.ts`

**Interfaces:**
- Consumes: `Lockfile`, `LockEntry`, `serializeLock` (Task 4); `sha256Hex` (Task 2).
- Produces:
  - `interface MrpackFile { path: string; hashes: { sha1: string; sha512: string }; env: { client: EnvNeed; server: EnvNeed }; downloads: string[]; fileSize: number }`
  - `type EnvNeed = "required" | "optional" | "unsupported"`
  - `interface MrpackIndex { formatVersion: 1; game: "minecraft"; versionId: string; name: string; summary?: string; files: MrpackFile[]; dependencies: Record<string, string> }`
  - `interface ExtraFile { path: string; data: Uint8Array }`
  - `clientEnv(f: LockEntry): MrpackFile["env"] | null`
  - `mrpackIndex(lock: Lockfile, meta: { name: string; summary?: string }): Promise<MrpackIndex>`
  - `buildMrpack(lock: Lockfile, meta: { name: string; summary?: string }, extras?: ExtraFile[]): Promise<Uint8Array>`
  - `isVanillaCompatible(lock: Lockfile): boolean`

- [ ] **Step 1: Write the failing test**

`packages/profile/test/mrpack.test.ts`:
```ts
import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import type { LockEntry, Lockfile } from "../src/lockfile";
import { buildMrpack, isVanillaCompatible, mrpackIndex } from "../src/mrpack";

function entry(slug: string, side: LockEntry["side"], clientOptional = false): LockEntry {
  return {
    slug,
    projectId: slug.toUpperCase(),
    versionId: `${slug}-v1`,
    versionNumber: "1.0",
    filename: `${slug}.jar`,
    url: `https://cdn.modrinth.com/data/${slug}.jar`,
    sha1: `sha1-${slug}`,
    sha512: `sha512-${slug}`,
    size: 42,
    side,
    clientOptional,
    auto: false,
    prerelease: false,
  };
}

const lock: Lockfile = {
  lockfileVersion: 1,
  profile: "test",
  profileHash: "h",
  minecraft: "26.3",
  javaMajor: 25,
  fabricLoader: "0.19.5",
  fabricInstaller: "1.1.2",
  files: [
    entry("lithium", "server"),
    entry("waystones", "both"),
    entry("voicechat", "both", true),
    entry("sodium", "client-optional"),
  ],
};

test("index maps sides to env and skips server-only files", async () => {
  const index = await mrpackIndex(lock, { name: "Test", summary: "s" });
  expect(index.formatVersion).toBe(1);
  expect(index.game).toBe("minecraft");
  expect(index.dependencies).toEqual({ minecraft: "26.3", "fabric-loader": "0.19.5" });
  expect(index.versionId).toMatch(/^26\.3-[0-9a-f]{12}$/);
  expect(index.files.map((f) => [f.path, f.env.client, f.env.server])).toEqual([
    ["mods/waystones.jar", "required", "required"],
    ["mods/voicechat.jar", "optional", "required"],
    ["mods/sodium.jar", "optional", "unsupported"],
  ]);
  expect(index.files[0]).toMatchObject({
    hashes: { sha1: "sha1-waystones", sha512: "sha512-waystones" },
    downloads: ["https://cdn.modrinth.com/data/waystones.jar"],
    fileSize: 42,
  });
});

test("the zip holds the index and overrides, and is byte-for-byte reproducible", async () => {
  const extra = { path: "mods/custom.jar", data: new Uint8Array([1, 2, 3]) };
  const a = await buildMrpack(lock, { name: "Test" }, [extra]);
  const b = await buildMrpack(lock, { name: "Test" }, [extra]);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  const files = unzipSync(a);
  expect(Object.keys(files).sort()).toEqual(["modrinth.index.json", "overrides/mods/custom.jar"]);
  expect(JSON.parse(strFromU8(files["modrinth.index.json"]!)).name).toBe("Test");
});

test("rejects override paths that escape the pack", async () => {
  await expect(buildMrpack(lock, { name: "T" }, [{ path: "../evil.jar", data: new Uint8Array() }])).rejects.toThrow(/Bad override path/);
});

test("isVanillaCompatible is false only when a client-required file exists", () => {
  expect(isVanillaCompatible(lock)).toBe(false);
  expect(isVanillaCompatible({ ...lock, files: lock.files.filter((f) => f.slug !== "waystones") })).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/profile/test/mrpack.test.ts`
Expected: FAIL, because `../src/mrpack` can't be resolved.

- [ ] **Step 3: Write the implementation**

`packages/profile/src/mrpack.ts`:
```ts
import { strToU8, zipSync, type Zippable } from "fflate";
import { UserError } from "./errors";
import { sha256Hex } from "./hash";
import { serializeLock, type LockEntry, type Lockfile } from "./lockfile";

export type EnvNeed = "required" | "optional" | "unsupported";

export interface MrpackFile {
  path: string;
  hashes: { sha1: string; sha512: string };
  env: { client: EnvNeed; server: EnvNeed };
  downloads: string[];
  fileSize: number;
}

export interface MrpackIndex {
  formatVersion: 1;
  game: "minecraft";
  versionId: string;
  name: string;
  summary?: string;
  files: MrpackFile[];
  dependencies: Record<string, string>;
}

/** A file bundled inside the pack under overrides/, e.g. a jar that only exists in R2. */
export interface ExtraFile {
  path: string;
  data: Uint8Array;
}

// Fixed timestamp so the same lockfile always produces the same bytes.
const FIXED_MTIME = new Date("2000-01-01T00:00:00Z");

/** env for the .mrpack, or null for files that stay on the server. */
export function clientEnv(f: LockEntry): MrpackFile["env"] | null {
  if (f.side === "server") return null;
  if (f.side === "both") return { client: f.clientOptional ? "optional" : "required", server: "required" };
  return { client: "optional", server: "unsupported" };
}

export async function mrpackIndex(lock: Lockfile, meta: { name: string; summary?: string }): Promise<MrpackIndex> {
  const files = lock.files.flatMap((f): MrpackFile[] => {
    const env = clientEnv(f);
    if (!env) return [];
    return [
      {
        path: `mods/${f.filename}`,
        hashes: { sha1: f.sha1, sha512: f.sha512 },
        env,
        downloads: [f.url],
        fileSize: f.size,
      },
    ];
  });
  const hash = (await sha256Hex(serializeLock(lock))).slice(0, 12);
  return {
    formatVersion: 1,
    game: "minecraft",
    versionId: `${lock.minecraft}-${hash}`,
    name: meta.name,
    ...(meta.summary ? { summary: meta.summary } : {}),
    files,
    dependencies: { minecraft: lock.minecraft, "fabric-loader": lock.fabricLoader },
  };
}

export async function buildMrpack(
  lock: Lockfile,
  meta: { name: string; summary?: string },
  extras: ExtraFile[] = [],
): Promise<Uint8Array> {
  const index = await mrpackIndex(lock, meta);
  const zip: Zippable = {
    "modrinth.index.json": [strToU8(JSON.stringify(index, null, 2)), { mtime: FIXED_MTIME }],
  };
  for (const e of extras) {
    if (e.path.startsWith("/") || e.path.split("/").includes("..")) throw new UserError(`Bad override path: ${e.path}`);
    zip[`overrides/${e.path}`] = [e.data, { mtime: FIXED_MTIME }];
  }
  return zipSync(zip, { level: 6 });
}

/** True when a vanilla client can join: no file is required on the client. */
export function isVanillaCompatible(lock: Lockfile): boolean {
  return !lock.files.some((f) => f.side === "both" && !f.clientOptional);
}
```

Append to `packages/profile/src/index.ts` (before `USER_AGENT`):
```ts
export * from "./mrpack";
```

- [ ] **Step 4: Run the tests, the typecheck and the purity check**

Run: `bun test packages/profile && bun run typecheck && ! grep -rnE "from \"(node|bun):" packages/profile/src`
Expected: every test passes, with no type errors. The grep prints nothing, because the package must stay free of Node and Bun imports so the Worker can reuse it.

- [ ] **Step 5: Commit**

```bash
git add packages/profile
git commit -m "feat(profile): reproducible .mrpack builder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Agent package, paths and verified download cache

**Files:**
- Create: `apps/agent/package.json`, `apps/agent/src/paths.ts`, `apps/agent/src/download.ts`
- Test: `apps/agent/test/paths.test.ts`, `apps/agent/test/download.test.ts`

**Interfaces:**
- Consumes: `sha256Hex`, `sha512Hex`, `UserError`, `Fetch` from `@mc/profile`.
- Produces:
  - `cacheDir(env?: Record<string, string | undefined>, platform?: string, home?: string): string`
  - `configDir(env?, platform?, home?): string`
  - `interface DownloadOptions { fetch: Fetch; cacheDir: string; userAgent: string }`
  - `fetchVerified(url: string, sha512: string | undefined, o: DownloadOptions): Promise<string>`, which returns the path of the cached file

- [ ] **Step 1: Create the package**

`apps/agent/package.json`:
```json
{
  "name": "@mc/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "mc-host": "src/cli.ts" },
  "scripts": {
    "build": "bun build src/cli.ts --compile --outfile dist/mc-host"
  },
  "dependencies": {
    "@mc/profile": "workspace:*"
  }
}
```

Run: `bun install`
Expected: links `@mc/profile` into the workspace.

- [ ] **Step 2: Write the failing tests**

`apps/agent/test/paths.test.ts`:
```ts
import { expect, test } from "bun:test";
import { cacheDir, configDir } from "../src/paths";

test("linux uses XDG dirs with home fallbacks", () => {
  expect(cacheDir({}, "linux", "/home/u")).toBe("/home/u/.cache/mc-host");
  expect(cacheDir({ XDG_CACHE_HOME: "/x" }, "linux", "/home/u")).toBe("/x/mc-host");
  expect(configDir({}, "linux", "/home/u")).toBe("/home/u/.config/mc-host");
});

test("windows uses LOCALAPPDATA and APPDATA with backslashes", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\f\\AppData\\Local", APPDATA: "C:\\Users\\f\\AppData\\Roaming" };
  expect(cacheDir(env, "win32", "C:\\Users\\f")).toBe("C:\\Users\\f\\AppData\\Local\\mc-host\\cache");
  expect(configDir(env, "win32", "C:\\Users\\f")).toBe("C:\\Users\\f\\AppData\\Roaming\\mc-host");
});
```

`apps/agent/test/download.test.ts`:
```ts
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha512Hex, type Fetch } from "@mc/profile";
import { fetchVerified } from "../src/download";

const good = new TextEncoder().encode("jar bytes");
const bad = new TextEncoder().encode("corrupt!!");
let dir: string;
let goodHash: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-dl-"));
  goodHash = await sha512Hex(good);
});

function serve(bodies: Uint8Array[]) {
  let calls = 0;
  const fetch: Fetch = async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)]!;
    calls++;
    return new Response(body);
  };
  return { fetch, calls: () => calls };
}

const URL_ = "https://cdn.modrinth.com/data/x/Waystones%201.0.jar";

test("downloads, verifies and caches by hash", async () => {
  const s = serve([good]);
  const path = await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(readFileSync(path)).toEqual(Buffer.from(good));
  await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(s.calls()).toBe(1);
});

test("retries once after a hash mismatch", async () => {
  const s = serve([bad, good]);
  const path = await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(readFileSync(path)).toEqual(Buffer.from(good));
  expect(s.calls()).toBe(2);
});

test("fails after two mismatches and leaves nothing in the cache", async () => {
  const s = serve([bad, bad]);
  await expect(fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" })).rejects.toThrow(
    /Waystones 1\.0\.jar was corrupted twice/,
  );
  const files = existsSync(join(dir, "files")) ? readdirSync(join(dir, "files"), { recursive: true }) : [];
  expect(files.filter((f) => String(f).length > 3)).toEqual([]);
});

test("re-downloads a cached file that was tampered with", async () => {
  const s = serve([good]);
  const path = await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  await Bun.write(path, bad);
  await fetchVerified(URL_, goodHash, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(s.calls()).toBe(2);
  expect(readFileSync(path)).toEqual(Buffer.from(good));
});

test("without a hash, caches by URL", async () => {
  const s = serve([good]);
  const a = await fetchVerified("https://meta.test/server/jar", undefined, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  const b = await fetchVerified("https://meta.test/server/jar", undefined, { fetch: s.fetch, cacheDir: dir, userAgent: "ua" });
  expect(a).toBe(b);
  expect(s.calls()).toBe(1);
});

test("an HTTP error is a plain-English UserError", async () => {
  const fetch: Fetch = async () => new Response("", { status: 503 });
  await expect(fetchVerified(URL_, goodHash, { fetch, cacheDir: dir, userAgent: "ua" })).rejects.toThrow(
    /Couldn't download Waystones 1\.0\.jar \(HTTP 503\)/,
  );
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test apps/agent`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 4: Write the implementation**

`apps/agent/src/paths.ts`:
```ts
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

type Env = Record<string, string | undefined>;

export function cacheDir(env: Env = process.env, platform: string = process.platform, home = homedir()): string {
  if (platform === "win32") return win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), "mc-host", "cache");
  return posix.join(env.XDG_CACHE_HOME ?? posix.join(home, ".cache"), "mc-host");
}

export function configDir(env: Env = process.env, platform: string = process.platform, home = homedir()): string {
  if (platform === "win32") return win32.join(env.APPDATA ?? win32.join(home, "AppData", "Roaming"), "mc-host");
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), "mc-host");
}
```

`apps/agent/src/download.ts`:
```ts
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256Hex, sha512Hex, UserError, type Fetch } from "@mc/profile";

export interface DownloadOptions {
  fetch: Fetch;
  cacheDir: string;
  userAgent: string;
}

/**
 * Download a file into the content cache and return its path.
 * With a sha512, the cached copy is re-checked and every download is verified (one retry).
 * Without one (the Fabric launcher), the file is cached by URL.
 */
export async function fetchVerified(url: string, sha512: string | undefined, o: DownloadOptions): Promise<string> {
  const key = sha512 ?? `url-${await sha256Hex(url)}`;
  const path = join(o.cacheDir, "files", key.slice(0, 2), key);
  if (existsSync(path) && (!sha512 || (await sha512Hex(await readFile(path))) === sha512)) return path;

  await mkdir(dirname(path), { recursive: true });
  const name = decodeURIComponent(basename(new URL(url).pathname));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await o.fetch(url, { headers: { "User-Agent": o.userAgent } });
    if (!res.ok) {
      throw new UserError(`Couldn't download ${name} (HTTP ${res.status}). Check your internet connection and try again.`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (sha512 && (await sha512Hex(data)) !== sha512) continue;
    const tmp = `${path}.part`;
    await writeFile(tmp, data);
    await rename(tmp, path);
    return path;
  }
  throw new UserError(
    `${name} was corrupted twice while downloading (its hash didn't match). Try again later. If it keeps happening, run "mc-host profile resolve" again, because the file on Modrinth may have changed.`,
  );
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test apps/agent && bun run typecheck`
Expected: every test passes, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/agent bun.lock
git commit -m "feat(agent): per-OS paths and verified download cache

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Server folder builder

**Files:**
- Create: `apps/agent/src/server/properties.ts`, `apps/agent/src/server/packs.ts`, `apps/agent/src/server/build.ts`
- Test: `apps/agent/test/properties.test.ts`, `apps/agent/test/packs.test.ts`, `apps/agent/test/build.test.ts`

**Interfaces:**
- Consumes:
  - `fetchVerified`, `DownloadOptions` (Task 6)
  - `serverLauncherUrl`, `UserError`, `Lockfile`, `Profile`, `Fetch` (from `@mc/profile`)
  - the test fake `makeProfile` (from `packages/profile/test/fakes.ts`)
- Produces:
  - `mergeProperties(existing: string, overrides: Record<string, string | number | boolean>): string`
  - `packNameFromFilename(filename: string): string | null`
  - `matchPacks(ids: string[], filenames: string[]): { found: Map<string, string>; missing: string[] }`
  - `LAUNCHER_JAR = "fabric-server-launch.jar"`, `MARKER = ".mc-host.json"`
  - `interface ServerMarker { profile: string; minecraft: string; javaMajor: number; memory: { min: string; max: string } }`
  - `interface BuildServerOptions { profile: Profile; lock: Lockfile; dir: string; packsDir?: string; fetch: Fetch; cacheDir: string; userAgent: string; log?: (line: string) => void }`
  - `buildServer(o: BuildServerOptions): Promise<{ mods: string[]; removed: string[]; datapacks: string[] }>`
  - `readMarker(dir: string): Promise<ServerMarker>`

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/properties.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mergeProperties } from "../src/server/properties";

test("replaces existing keys in place, keeps comments and other keys", () => {
  const existing = "#Minecraft server properties\ndifficulty=easy\nlevel-seed=123\n";
  expect(mergeProperties(existing, { difficulty: "hard" })).toBe(
    "#Minecraft server properties\ndifficulty=hard\nlevel-seed=123\n",
  );
});

test("appends new keys sorted", () => {
  expect(mergeProperties("", { "view-distance": 10, difficulty: "normal", pvp: true })).toBe(
    "difficulty=normal\npvp=true\nview-distance=10\n",
  );
});

test("handles CRLF files", () => {
  expect(mergeProperties("a=1\r\nb=2\r\n", { b: 3 })).toBe("a=1\nb=3\n");
});
```

`apps/agent/test/packs.test.ts`:
```ts
import { expect, test } from "bun:test";
import { matchPacks, packNameFromFilename } from "../src/server/packs";

// Review focus 5: real Vanilla Tweaks names
test("normalizes Vanilla Tweaks file names", () => {
  expect(packNameFromFilename("afk display v1.1.17 (MC 26.2).zip")).toBe("afk-display");
  expect(packNameFromFilename("more mob heads v2.20.0 (MC 26.2).zip")).toBe("more-mob-heads");
  expect(packNameFromFilename("track raw statistics v1.7.13 (MC 26.2).zip")).toBe("track-raw-statistics");
  expect(packNameFromFilename("MyPack.zip")).toBe("mypack");
  expect(packNameFromFilename("readme.txt")).toBeNull();
});

test("matches ids to files and lists missing ones", () => {
  const { found, missing } = matchPacks(
    ["vt:afk-display", "vt:wood-stripper", "vt:ghost"],
    ["afk display v1.1.17 (MC 26.2).zip", "wood stripper v1.0.1 (MC 26.2).zip", "notes.txt"],
  );
  expect([...found]).toEqual([
    ["vt:afk-display", "afk display v1.1.17 (MC 26.2).zip"],
    ["vt:wood-stripper", "wood stripper v1.0.1 (MC 26.2).zip"],
  ]);
  expect(missing).toEqual(["vt:ghost"]);
});
```

`apps/agent/test/build.test.ts`:
```ts
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha512Hex, type Fetch, type LockEntry, type Lockfile } from "@mc/profile";
import { makeProfile } from "../../../packages/profile/test/fakes";
import { buildServer, LAUNCHER_JAR, MARKER, readMarker } from "../src/server/build";

let root: string;
let serverDir: string;
let packsDir: string;
let cache: string;
const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-build-"));
  serverDir = join(root, "server");
  packsDir = join(root, "packs");
  cache = join(root, "cache");
  mkdirSync(packsDir);
  writeFileSync(join(packsDir, "afk display v1.1.17 (MC 26.2).zip"), "zip");
});

async function entry(slug: string, side: LockEntry["side"]): Promise<LockEntry> {
  return {
    slug,
    projectId: slug,
    versionId: "v",
    versionNumber: "1",
    filename: `${slug}.jar`,
    url: `https://cdn.test/${slug}.jar`,
    sha1: "x",
    sha512: await sha512Hex(bytes(slug)),
    size: slug.length,
    side,
    clientOptional: false,
    auto: false,
    prerelease: false,
  };
}

async function makeLock(): Promise<Lockfile> {
  return {
    lockfileVersion: 1,
    profile: "test",
    profileHash: "h",
    minecraft: "26.3",
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files: [await entry("lithium", "server"), await entry("waystones", "both"), await entry("sodium", "client-optional")],
  };
}

const fetch: Fetch = async (url) => {
  if (url.endsWith("/server/jar")) return new Response(bytes("launcher"));
  const slug = url.split("/").pop()!.replace(".jar", "");
  return new Response(bytes(slug));
};

const profile = makeProfile({ properties: { difficulty: "hard" }, datapacks: ["vt:afk-display"] });

test("builds launcher, server-side mods, properties, datapacks and marker", async () => {
  const result = await buildServer({ profile, lock: await makeLock(), dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" });
  expect(readFileSync(join(serverDir, LAUNCHER_JAR), "utf8")).toBe("launcher");
  expect(readdirSync(join(serverDir, "mods")).sort()).toEqual(["lithium.jar", "waystones.jar"]);
  expect(result.mods).toEqual(["lithium.jar", "waystones.jar"]);
  expect(readFileSync(join(serverDir, "server.properties"), "utf8")).toContain("difficulty=hard");
  expect(existsSync(join(serverDir, "world", "datapacks", "afk display v1.1.17 (MC 26.2).zip"))).toBe(true);
  expect(existsSync(join(serverDir, "eula.txt"))).toBe(false);
  expect(await readMarker(serverDir)).toEqual({ profile: "test", minecraft: "26.3", javaMajor: 25, memory: { min: "2G", max: "4G" } });
});

// Review focus 4
test("removes jars the lockfile no longer lists, keeps config files", async () => {
  const lock = await makeLock();
  await buildServer({ profile, lock, dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" });
  writeFileSync(join(serverDir, "mods", "config-note.txt"), "keep me");
  lock.files = lock.files.filter((f) => f.slug !== "waystones");
  const result = await buildServer({ profile, lock, dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" });
  expect(result.removed).toEqual(["waystones.jar"]);
  expect(readdirSync(join(serverDir, "mods")).sort()).toEqual(["config-note.txt", "lithium.jar"]);
});

test("never touches datapacks of an existing world", async () => {
  mkdirSync(join(serverDir, "world"), { recursive: true });
  const result = await buildServer({ profile, lock: await makeLock(), dir: serverDir, fetch, cacheDir: cache, userAgent: "ua" });
  expect(result.datapacks).toEqual([]);
  expect(existsSync(join(serverDir, "world", "datapacks"))).toBe(false);
});

// Review focus 5
test("missing packs fail before a world folder is created", async () => {
  const p = makeProfile({ datapacks: ["vt:afk-display", "vt:ghost"] });
  await expect(buildServer({ profile: p, lock: await makeLock(), dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(
    /These datapacks aren't in .*: vt:ghost/,
  );
  expect(existsSync(join(serverDir, "world"))).toBe(false);
});

test("asks for --packs when datapacks are needed and none were given", async () => {
  await expect(buildServer({ profile, lock: await makeLock(), dir: serverDir, fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(/--packs/);
});

test("rejects a lockfile filename that escapes mods/", async () => {
  const lock = await makeLock();
  lock.files[0]!.filename = "../evil.jar";
  await expect(buildServer({ profile, lock, dir: serverDir, packsDir, fetch, cacheDir: cache, userAgent: "ua" })).rejects.toThrow(/Unsafe file name/);
});

test("readMarker explains a folder that was not built by mc-host", async () => {
  await expect(readMarker(root)).rejects.toThrow(/isn't a server folder built by mc-host/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/agent`
Expected: FAIL, because the `../src/server/*` modules can't be resolved.

- [ ] **Step 3: Write the implementation**

`apps/agent/src/server/properties.ts`:
```ts
/** Apply overrides to a server.properties text: replace keys in place, append new ones sorted. */
export function mergeProperties(existing: string, overrides: Record<string, string | number | boolean>): string {
  const remaining = new Map(Object.entries(overrides).map(([k, v]) => [k, String(v)]));
  const lines = existing.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const out = lines.map((line) => {
    const m = /^([^#!=\s][^=]*)=/.exec(line);
    const key = m?.[1]?.trim();
    if (!key || !remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const key of [...remaining.keys()].sort()) out.push(`${key}=${remaining.get(key)}`);
  return out.join("\n") + "\n";
}
```

`apps/agent/src/server/packs.ts`:
```ts
/** "afk display v1.1.17 (MC 26.2).zip" → "afk-display". Null for non-zip files. */
export function packNameFromFilename(filename: string): string | null {
  if (!filename.toLowerCase().endsWith(".zip")) return null;
  const base = filename.slice(0, -4).replace(/\s+v\d[\w.]*(\s*\([^)]*\))?\s*$/i, "");
  const name = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return name || null;
}

/** Match profile pack ids ("vt:afk-display") to files by the part after the colon. */
export function matchPacks(ids: string[], filenames: string[]): { found: Map<string, string>; missing: string[] } {
  const byName = new Map<string, string>();
  for (const f of filenames) {
    const n = packNameFromFilename(f);
    if (n) byName.set(n, f);
  }
  const found = new Map<string, string>();
  const missing: string[] = [];
  for (const id of ids) {
    const file = byName.get(id.slice(id.indexOf(":") + 1));
    if (file) found.set(id, file);
    else missing.push(id);
  }
  return { found, missing };
}
```

`apps/agent/src/server/build.ts`:
```ts
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serverLauncherUrl, UserError, type Fetch, type Lockfile, type Profile } from "@mc/profile";
import { fetchVerified } from "../download";
import { matchPacks } from "./packs";
import { mergeProperties } from "./properties";

export const LAUNCHER_JAR = "fabric-server-launch.jar";
export const MARKER = ".mc-host.json";

export interface ServerMarker {
  profile: string;
  minecraft: string;
  javaMajor: number;
  memory: { min: string; max: string };
}

export interface BuildServerOptions {
  profile: Profile;
  lock: Lockfile;
  dir: string;
  packsDir?: string;
  fetch: Fetch;
  cacheDir: string;
  userAgent: string;
  log?: (line: string) => void;
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

  // Check datapacks first so a missing pack never leaves a half-built folder behind.
  const packs = await planDatapacks(o);

  await mkdir(join(o.dir, "mods"), { recursive: true });
  const launcher = await fetchVerified(serverLauncherUrl(o.lock.minecraft, o.lock.fabricLoader, o.lock.fabricInstaller), undefined, dl);
  await copyFile(launcher, join(o.dir, LAUNCHER_JAR));
  log(`Fabric ${o.lock.fabricLoader} launcher for Minecraft ${o.lock.minecraft}`);

  for (const f of wanted) {
    await copyFile(await fetchVerified(f.url, f.sha512, dl), join(o.dir, "mods", f.filename));
  }
  const keep = new Set(wanted.map((f) => f.filename));
  const removed = (await readdir(join(o.dir, "mods"))).filter((n) => n.endsWith(".jar") && !keep.has(n)).sort();
  for (const n of removed) await rm(join(o.dir, "mods", n));
  log(`${wanted.length} mods installed${removed.length ? `, removed ${removed.join(", ")}` : ""}`);

  const propsPath = join(o.dir, "server.properties");
  const existing = existsSync(propsPath) ? await readFile(propsPath, "utf8") : "";
  await writeFile(propsPath, mergeProperties(existing, o.profile.properties));

  if (packs) {
    await mkdir(packs.target, { recursive: true });
    for (const file of packs.files) await copyFile(join(o.packsDir!, file), join(packs.target, file));
    log(`${packs.files.length} datapacks copied into ${packs.target}`);
  }

  const marker: ServerMarker = {
    profile: o.profile.name,
    minecraft: o.lock.minecraft,
    javaMajor: o.lock.javaMajor,
    memory: o.profile.memory,
  };
  await writeFile(join(o.dir, MARKER), JSON.stringify(marker, null, 2) + "\n");
  return { mods: wanted.map((f) => f.filename).sort(), removed, datapacks: packs?.files ?? [] };
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
  const { found, missing } = matchPacks(o.profile.datapacks, await readdir(o.packsDir));
  if (missing.length) {
    throw new UserError(`These datapacks aren't in ${o.packsDir}: ${missing.join(", ")}. Add their zips, or remove them from the profile.`);
  }
  return { target: join(o.dir, levelName, "datapacks"), files: [...found.values()] };
}

export async function readMarker(dir: string): Promise<ServerMarker> {
  const path = join(dir, MARKER);
  if (!existsSync(path)) {
    throw new UserError(`${dir} isn't a server folder built by mc-host. Run "mc-host profile build-server <profile> ${dir}" first.`);
  }
  return JSON.parse(await readFile(path, "utf8")) as ServerMarker;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `bun test apps/agent && bun run typecheck`
Expected: every test passes, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): build a Fabric server folder from a lockfile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Running the server: Java check, EULA and crash summary

**Files:**
- Create: `apps/agent/src/run/java.ts`, `apps/agent/src/run/config.ts`, `apps/agent/src/run/eula.ts`, `apps/agent/src/run/crash.ts`, `apps/agent/src/run/server.ts`
- Test: `apps/agent/test/run.test.ts`

**Interfaces:**
- Consumes: `LAUNCHER_JAR`, `ServerMarker` (Task 7).
- Produces:
  - `parseJavaMajor(output: string): number | null`
  - `javaMajor(javaBin?: string): number | null`
  - `interface AgentConfig { eulaAccepted?: boolean }`
  - `readConfig(dir: string): Promise<AgentConfig>`
  - `writeConfig(dir: string, cfg: AgentConfig): Promise<void>`
  - `EULA_URL`
  - `ensureEula(o: { configDir: string; serverDir: string; ask: (q: string) => Promise<string>; log: (l: string) => void }): Promise<boolean>`
  - `suspectMod(text: string): string | null`
  - `crashSummary(serverDir: string, sinceMs?: number, lines?: number): Promise<string>`
  - `runServer(o: { dir: string; marker: ServerMarker; javaBin?: string }): Promise<number>`

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/run.test.ts`:
```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/run/config";
import { crashSummary, suspectMod } from "../src/run/crash";
import { ensureEula } from "../src/run/eula";
import { parseJavaMajor } from "../src/run/java";

test("parseJavaMajor handles modern and legacy version strings", () => {
  expect(parseJavaMajor('openjdk version "25.0.4" 2026-07-21\nOpenJDK Runtime')).toBe(25);
  expect(parseJavaMajor('java version "1.8.0_392"')).toBe(8);
  expect(parseJavaMajor('openjdk version "21" 2023-09-19')).toBe(21);
  expect(parseJavaMajor("command not found")).toBeNull();
});

describe("ensureEula", () => {
  let cfg: string;
  let server: string;
  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "mc-cfg-"));
    server = mkdtempSync(join(tmpdir(), "mc-srv-"));
  });

  test("asks once, remembers yes, writes eula.txt", async () => {
    const asked: string[] = [];
    const ask = async (q: string) => (asked.push(q), "YES ");
    expect(await ensureEula({ configDir: cfg, serverDir: server, ask, log: () => {} })).toBe(true);
    expect(readFileSync(join(server, "eula.txt"), "utf8")).toBe("eula=true\n");
    expect((await readConfig(cfg)).eulaAccepted).toBe(true);
    const server2 = mkdtempSync(join(tmpdir(), "mc-srv-"));
    expect(await ensureEula({ configDir: cfg, serverDir: server2, ask, log: () => {} })).toBe(true);
    expect(asked.length).toBe(1);
  });

  test("anything but yes refuses and writes nothing", async () => {
    expect(await ensureEula({ configDir: cfg, serverDir: server, ask: async () => "y", log: () => {} })).toBe(false);
    expect(existsSync(join(server, "eula.txt"))).toBe(false);
    expect((await readConfig(cfg)).eulaAccepted).toBeUndefined();
  });
});

describe("crash summary", () => {
  test("suspectMod finds Fabric dependency errors and suspected mods", () => {
    expect(suspectMod("Incompatible mods found!\n\t - Mod 'Waystones' (waystones) 26.3 requires any version of balm")).toBe("Waystones");
    expect(suspectMod("Suspected Mods: Lootr (lootr)")).toBe("Lootr (lootr)");
    expect(suspectMod("Suspected Mods: NONE")).toBeNull();
    expect(suspectMod("all fine")).toBeNull();
  });

  test("crashSummary tails the log and ignores crash reports older than the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-crash-"));
    mkdirSync(join(dir, "logs"));
    mkdirSync(join(dir, "crash-reports"));
    const log = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(dir, "logs", "latest.log"), log);
    const old = join(dir, "crash-reports", "crash-old.txt");
    writeFileSync(old, "Suspected Mods: OldMod (old)");
    utimesSync(old, new Date(2000, 0, 1), new Date(2000, 0, 1));
    const summary = await crashSummary(dir, Date.now() - 60_000);
    expect(summary).toContain("line 40");
    expect(summary).toContain("line 11");
    expect(summary).not.toContain("line 10\n");
    expect(summary).not.toContain("OldMod");
    writeFileSync(join(dir, "crash-reports", "crash-new.txt"), "Suspected Mods: Lootr (lootr)");
    expect(await crashSummary(dir, Date.now() - 60_000)).toContain("The crash looks related to: Lootr (lootr)");
  });

  test("crashSummary with no log says so", async () => {
    expect(await crashSummary(mkdtempSync(join(tmpdir(), "mc-empty-")))).toContain("exited before writing a log");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/agent/test/run.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Write the implementation**

`apps/agent/src/run/java.ts`:
```ts
/** 'openjdk version "25.0.4"' → 25, 'java version "1.8.0_392"' → 8. */
export function parseJavaMajor(output: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) return null;
  const first = Number(m[1]);
  return first === 1 && m[2] ? Number(m[2]) : first;
}

/** Major version of the java on PATH (or javaBin), or null if it can't be run. */
export function javaMajor(javaBin = "java"): number | null {
  try {
    const p = Bun.spawnSync([javaBin, "-version"]);
    return parseJavaMajor(p.stderr.toString() + p.stdout.toString());
  } catch {
    return null;
  }
}
```

`apps/agent/src/run/config.ts`:
```ts
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentConfig {
  eulaAccepted?: boolean;
}

export async function readConfig(dir: string): Promise<AgentConfig> {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, "utf8")) as AgentConfig;
}

export async function writeConfig(dir: string, cfg: AgentConfig): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}
```

`apps/agent/src/run/eula.ts`:
```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig, writeConfig } from "./config";

export const EULA_URL = "https://aka.ms/MinecraftEULA";

/** Ask for the EULA once per PC; never accept on the user's behalf. Returns false if they decline. */
export async function ensureEula(o: {
  configDir: string;
  serverDir: string;
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
}): Promise<boolean> {
  const cfg = await readConfig(o.configDir);
  if (!cfg.eulaAccepted) {
    o.log(`Running a Minecraft server means agreeing to Mojang's EULA: ${EULA_URL}`);
    const answer = (await o.ask('Type "yes" to agree: ')).trim().toLowerCase();
    if (answer !== "yes") return false;
    await writeConfig(o.configDir, { ...cfg, eulaAccepted: true });
  }
  await writeFile(join(o.serverDir, "eula.txt"), "eula=true\n");
  return true;
}
```

`apps/agent/src/run/crash.ts`:
```ts
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const PATTERNS = [/Suspected Mods?:\s*([^\n]+)/i, /- Mod '([^']+)'/];

export function suspectMod(text: string): string | null {
  for (const p of PATTERNS) {
    const name = p.exec(text)?.[1]?.trim();
    if (name && !/^(none|unknown|minecraft)\b/i.test(name)) return name;
  }
  return null;
}

/** Last lines of logs/latest.log plus a hint from the newest crash report written since sinceMs. */
export async function crashSummary(serverDir: string, sinceMs = 0, lines = 30): Promise<string> {
  const logPath = join(serverDir, "logs", "latest.log");
  const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "";

  let report = "";
  const reportsDir = join(serverDir, "crash-reports");
  if (existsSync(reportsDir)) {
    const recent: { path: string; mtime: number }[] = [];
    for (const name of await readdir(reportsDir)) {
      const path = join(reportsDir, name);
      const { mtimeMs } = await stat(path);
      if (name.endsWith(".txt") && mtimeMs >= sinceMs) recent.push({ path, mtime: mtimeMs });
    }
    const newest = recent.sort((a, b) => b.mtime - a.mtime)[0];
    if (newest) report = await readFile(newest.path, "utf8");
  }

  const out: string[] = log
    ? [`Last ${lines} lines of logs/latest.log:`, ...log.trimEnd().split(/\r?\n/).slice(-lines)]
    : ["The server exited before writing a log."];
  const suspect = suspectMod(`${report}\n${log}`);
  if (suspect) {
    out.push("", `The crash looks related to: ${suspect}. Try removing it from the profile (or moving it to "waiting") and build again.`);
  }
  return out.join("\n");
}
```

`apps/agent/src/run/server.ts`:
```ts
import { LAUNCHER_JAR, type ServerMarker } from "../server/build";

/** Run the server in the foreground with the console attached. Returns the exit code. */
export async function runServer(o: { dir: string; marker: ServerMarker; javaBin?: string }): Promise<number> {
  const proc = Bun.spawn(
    [o.javaBin ?? "java", `-Xms${o.marker.memory.min}`, `-Xmx${o.marker.memory.max}`, "-jar", LAUNCHER_JAR, "nogui"],
    { cwd: o.dir, stdio: ["inherit", "inherit", "inherit"] },
  );
  return await proc.exited;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `bun test apps/agent && bun run typecheck`
Expected: every test passes, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): java check, EULA prompt and crash summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `mc-host profile` commands and CLI

**Files:**
- Create: `apps/agent/src/commands.ts`, `apps/agent/src/cli.ts`
- Test: `apps/agent/test/cli.test.ts`, `apps/agent/test/commands.test.ts`

**Interfaces:**
- Consumes: everything above. Tests reuse `FakeModrinth`, `fakeFabric` and `fakeMojang` from `packages/profile/test/fakes.ts`.
- Produces:
  - `type Command`, as a union of `resolve`, `build-server`, `build-mrpack`, `run` and `help`
  - `USAGE`
  - `parseCommand(argv: string[]): Command`
  - `interface Deps { fetch: Fetch; cacheDir: string; configDir: string; log: (line: string) => void; ask: (q: string) => Promise<string>; clients?: ResolveDeps; javaBin?: string; now?: () => number }`
  - `loadProfile(profilesDir: string, name: string): Promise<{ profile: Profile; path: string; raw: Record<string, unknown> }>`
  - `loadLock(profilesDir: string, name: string, profile: Profile): Promise<Lockfile>`
  - `runCommand(cmd: Command, deps: Deps): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/cli.test.ts`:
```ts
import { expect, test } from "bun:test";
import { parseCommand } from "../src/cli";

test("parses each profile subcommand", () => {
  expect(parseCommand(["profile", "resolve", "adventure"])).toEqual({ kind: "resolve", name: "adventure", check: undefined, addReady: false, profilesDir: "profiles" });
  expect(parseCommand(["profile", "resolve", "adventure", "--check", "26.4", "--add-ready"])).toMatchObject({ check: "26.4", addReady: true });
  expect(parseCommand(["profile", "build-server", "adventure", "srv", "--packs", "vt"])).toEqual({
    kind: "build-server", name: "adventure", dir: "srv", packsDir: "vt", profilesDir: "profiles",
  });
  expect(parseCommand(["profile", "build-mrpack", "adventure", "out.mrpack", "--profiles", "p"])).toEqual({
    kind: "build-mrpack", name: "adventure", out: "out.mrpack", profilesDir: "p",
  });
  expect(parseCommand(["profile", "run", "srv"])).toEqual({ kind: "run", dir: "srv" });
});

test("help for no args or --help", () => {
  expect(parseCommand([])).toEqual({ kind: "help" });
  expect(parseCommand(["--help"])).toEqual({ kind: "help" });
});

test("plain-English errors for missing args, unknown commands and flags", () => {
  expect(() => parseCommand(["profile", "build-server", "adventure"])).toThrow(/Missing <dir>/);
  expect(() => parseCommand(["profile", "frobnicate"])).toThrow(/Unknown command "profile frobnicate"/);
  expect(() => parseCommand(["profile", "resolve", "x", "--nope"])).toThrow(/Unknown option/);
});
```

`apps/agent/test/commands.test.ts`:
```ts
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLock } from "@mc/profile";
import { FakeModrinth, fakeFabric, fakeMojang } from "../../../packages/profile/test/fakes";
import { runCommand, type Deps } from "../src/commands";

let dir: string;
let lines: string[];
let deps: Deps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-cmd-"));
  lines = [];
  const mr = new FakeModrinth();
  mr.add("lithium", [{}], { client: "optional", server: "optional" });
  mr.add("lootr", [{}], { client: "required", server: "required" });
  mr.add("carry-on", [{ game_versions: ["26.2"] }]);
  deps = {
    fetch: async () => new Response("unused", { status: 500 }),
    cacheDir: join(dir, "cache"),
    configDir: join(dir, "config"),
    log: (l) => void lines.push(l),
    ask: async () => "no",
    clients: { modrinth: mr, fabric: fakeFabric, mojang: fakeMojang },
  };
  writeProfile({});
});

function writeProfile(over: Record<string, unknown>) {
  const profile = {
    name: "test",
    description: "t",
    minecraft: "26.3",
    loader: { fabric: "latest-stable" },
    memory: { min: "2G", max: "4G" },
    mods: [{ modrinth: "lithium", side: "server" }],
    waiting: ["lootr", "carry-on"],
    ...over,
  };
  writeFileSync(join(dir, "test.json"), JSON.stringify(profile, null, 2));
}

test("resolve writes the lockfile and reports waiting mods", async () => {
  await runCommand({ kind: "resolve", name: "test", addReady: false, profilesDir: dir }, deps);
  const lock = parseLock(readFileSync(join(dir, "test.lock.json"), "utf8"), "lock");
  expect(lock.files.map((f) => f.slug)).toEqual(["lithium"]);
  expect(lines.join("\n")).toContain('Now available: lootr. Run "mc-host profile resolve test --add-ready" to add them.');
  expect(lines.join("\n")).toContain("Still waiting: carry-on.");
});

test("--add-ready moves ready mods into the profile with a suggested side", async () => {
  await runCommand({ kind: "resolve", name: "test", addReady: true, profilesDir: dir }, deps);
  const saved = JSON.parse(readFileSync(join(dir, "test.json"), "utf8"));
  expect(saved.mods).toContainEqual({ modrinth: "lootr", side: "both" });
  expect(saved.waiting).toEqual(["carry-on"]);
  const lock = parseLock(readFileSync(join(dir, "test.lock.json"), "utf8"), "lock");
  expect(lock.files.map((f) => f.slug)).toEqual(["lithium", "lootr"]);
});

test("--check reports availability without writing a lockfile", async () => {
  await runCommand({ kind: "resolve", name: "test", check: "26.2", addReady: false, profilesDir: dir }, deps);
  expect(existsSync(join(dir, "test.lock.json"))).toBe(false);
  expect(lines.join("\n")).toContain("carry-on: available (waiting)");
});

// Review focus 3
test("build commands refuse a lockfile that is older than the profile", async () => {
  await runCommand({ kind: "resolve", name: "test", addReady: false, profilesDir: dir }, deps);
  writeProfile({ properties: { difficulty: "hard" } });
  await expect(
    runCommand({ kind: "build-mrpack", name: "test", out: join(dir, "t.mrpack"), profilesDir: dir }, deps),
  ).rejects.toThrow(/test\.json changed since its lockfile was made\. Run "mc-host profile resolve test" first\./);
});

test("build-mrpack writes the pack and says whether it is required", async () => {
  await runCommand({ kind: "resolve", name: "test", addReady: false, profilesDir: dir }, deps);
  await runCommand({ kind: "build-mrpack", name: "test", out: join(dir, "t.mrpack"), profilesDir: dir }, deps);
  expect(existsSync(join(dir, "t.mrpack"))).toBe(true);
  expect(lines.join("\n")).toContain("Vanilla clients can join this world");
});

test("a missing profile lists the ones that exist", async () => {
  await expect(runCommand({ kind: "resolve", name: "nope", addReady: false, profilesDir: dir }, deps)).rejects.toThrow(
    /No profile called "nope"\. Available: test/,
  );
});

test("a missing lockfile says to resolve first", async () => {
  await expect(runCommand({ kind: "build-mrpack", name: "test", out: "x", profilesDir: dir }, deps)).rejects.toThrow(
    /Run "mc-host profile resolve test" first/,
  );
});

test("run refuses when the EULA is declined", async () => {
  const srv = join(dir, "srv");
  await Bun.write(join(srv, ".mc-host.json"), JSON.stringify({ profile: "test", minecraft: "26.3", javaMajor: 8, memory: { min: "1G", max: "1G" } }));
  await expect(runCommand({ kind: "run", dir: srv }, deps)).rejects.toThrow(/You need to agree to the EULA/);
});

test("run refuses a Java that is too old", async () => {
  const srv = join(dir, "srv");
  await Bun.write(join(srv, ".mc-host.json"), JSON.stringify({ profile: "test", minecraft: "26.3", javaMajor: 99, memory: { min: "1G", max: "1G" } }));
  await expect(runCommand({ kind: "run", dir: srv }, deps)).rejects.toThrow(/Minecraft 26\.3 needs Java 99, but this PC has Java \d+/);
});
```

The two `run` tests use the real `java` on PATH (Java 25 on this machine). The EULA test sets `javaMajor: 8` so the Java check passes and the EULA prompt is reached. The Java test sets 99 so the check fails.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/agent/test/cli.test.ts apps/agent/test/commands.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Write `commands.ts`**

`apps/agent/src/commands.ts`:
```ts
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
  isVanillaCompatible,
  parseLock,
  parseProfile,
  profileHash,
  resolveProfile,
  serializeLock,
  USER_AGENT,
  UserError,
  type Fetch,
  type Lockfile,
  type Profile,
  type ResolveDeps,
} from "@mc/profile";
import type { Command } from "./cli";
import { crashSummary } from "./run/crash";
import { ensureEula } from "./run/eula";
import { javaMajor } from "./run/java";
import { runServer } from "./run/server";
import { buildServer, readMarker } from "./server/build";

export interface Deps {
  fetch: Fetch;
  cacheDir: string;
  configDir: string;
  log: (line: string) => void;
  ask: (question: string) => Promise<string>;
  /** Override the API clients (tests). Defaults to the live Modrinth, Fabric and Mojang APIs. */
  clients?: ResolveDeps;
  javaBin?: string;
  now?: () => number;
}

function clientsFor(deps: Deps): ResolveDeps {
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

  const { lock, warnings, waiting } = await resolveProfile(profile, clients);
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
    fetch: deps.fetch,
    cacheDir: deps.cacheDir,
    userAgent: USER_AGENT,
    log: deps.log,
  });
  deps.log(`Server ready in ${cmd.dir}. Start it with: mc-host profile run ${cmd.dir}`);
}

async function cmdBuildMrpack(cmd: Extract<Command, { kind: "build-mrpack" }>, deps: Deps): Promise<void> {
  const { profile } = await loadProfile(cmd.profilesDir, cmd.name);
  const lock = await loadLock(cmd.profilesDir, cmd.name, profile);
  const bytes = await buildMrpack(lock, { name: `${profile.name} (Minecraft ${lock.minecraft})`, summary: profile.description });
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
  const java = javaMajor(deps.javaBin);
  if (java === null) {
    throw new UserError(`Java isn't installed or isn't on your PATH. Minecraft ${marker.minecraft} needs Java ${marker.javaMajor}.`);
  }
  if (java < marker.javaMajor) {
    throw new UserError(`Minecraft ${marker.minecraft} needs Java ${marker.javaMajor}, but this PC has Java ${java}. Install Java ${marker.javaMajor} and try again.`);
  }
  const agreed = await ensureEula({ configDir: deps.configDir, serverDir: cmd.dir, ask: deps.ask, log: deps.log });
  if (!agreed) throw new UserError("You need to agree to the EULA to run a server.");
  const started = (deps.now ?? Date.now)();
  const code = await runServer({ dir: cmd.dir, marker, javaBin: deps.javaBin });
  // 130/143: stopped with Ctrl+C or a terminate signal, which is a normal stop.
  if (code !== 0 && code !== 130 && code !== 143) {
    deps.log(await crashSummary(cmd.dir, started));
    throw new UserError(`The server stopped with exit code ${code}.`);
  }
}

export async function runCommand(cmd: Command, deps: Deps): Promise<void> {
  switch (cmd.kind) {
    case "help":
      return;
    case "resolve":
      return cmdResolve(cmd, deps);
    case "build-server":
      return cmdBuildServer(cmd, deps);
    case "build-mrpack":
      return cmdBuildMrpack(cmd, deps);
    case "run":
      return cmdRun(cmd, deps);
  }
}
```

- [ ] **Step 4: Write `cli.ts`**

`apps/agent/src/cli.ts`:
```ts
#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { UserError } from "@mc/profile";
import { runCommand } from "./commands";
import { cacheDir, configDir } from "./paths";

export type Command =
  | { kind: "resolve"; name: string; check?: string; addReady: boolean; profilesDir: string }
  | { kind: "build-server"; name: string; dir: string; packsDir?: string; profilesDir: string }
  | { kind: "build-mrpack"; name: string; out: string; profilesDir: string }
  | { kind: "run"; dir: string }
  | { kind: "help" };

export const USAGE = `mc-host profile <command>

  resolve <profile> [--check <mc-version>] [--add-ready]
      Pin exact mod versions into profiles/<profile>.lock.json.
      --check        only report which mods exist for another Minecraft version
      --add-ready    move "waiting" mods that now have a build into "mods"
  build-server <profile> <dir> [--packs <folder>]
      Put the Fabric server, server-side mods and datapacks in <dir>.
  build-mrpack <profile> <out.mrpack>
      Write a modpack that Prism Launcher can import.
  run <dir>
      Start a server folder made by build-server.

Options: --profiles <folder> (default: profiles)`;

export function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        check: { type: "string" },
        "add-ready": { type: "boolean", default: false },
        packs: { type: "string" },
        profiles: { type: "string", default: "profiles" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new UserError(`${(err as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [group, sub, a, b] = positionals;
  if (values.help || group !== "profile" || !sub) return { kind: "help" };
  const profilesDir = values.profiles ?? "profiles";
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new UserError(`Missing ${what}.\n\n${USAGE}`);
    return v;
  };
  switch (sub) {
    case "resolve":
      return { kind: "resolve", name: need(a, "<profile>"), check: values.check, addReady: values["add-ready"] ?? false, profilesDir };
    case "build-server":
      return { kind: "build-server", name: need(a, "<profile>"), dir: need(b, "<dir>"), packsDir: values.packs, profilesDir };
    case "build-mrpack":
      return { kind: "build-mrpack", name: need(a, "<profile>"), out: need(b, "<out.mrpack>"), profilesDir };
    case "run":
      return { kind: "run", dir: need(a, "<dir>") };
    default:
      throw new UserError(`Unknown command "profile ${sub}".\n\n${USAGE}`);
  }
}

async function main(): Promise<void> {
  try {
    const cmd = parseCommand(process.argv.slice(2));
    if (cmd.kind === "help") {
      console.log(USAGE);
      return;
    }
    await runCommand(cmd, {
      fetch: (input, init) => fetch(input, init),
      cacheDir: cacheDir(),
      configDir: configDir(),
      log: (line) => console.log(line),
      ask: async (q) => prompt(q) ?? "",
    });
  } catch (err) {
    if (err instanceof UserError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err);
    process.exit(2);
  }
}

if (import.meta.main) await main();
```

Note: the test for `parseCommand(["profile","resolve","adventure"])` expects `check: undefined` as a key. `toEqual` treats `undefined` properties as equal to missing ones, so the object literal above passes.

- [ ] **Step 5: Run the tests, the typecheck and a compile smoke test**

Run: `bun test && bun run typecheck && (cd apps/agent && bun run build) && ./apps/agent/dist/mc-host --help`
Expected:
- all tests across both packages pass, with no type errors
- `apps/agent/dist/mc-host` is built, and `dist/` is gitignored
- `--help` prints `USAGE`

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): mc-host profile resolve/build-server/build-mrpack/run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The two real profiles, their lockfiles, and the live smoke test

**Files:**
- Create: `profiles/vanilla-plus.json`, `profiles/adventure.json`, `profiles/vanilla-plus.lock.json` (generated), `profiles/adventure.lock.json` (generated), `packages/profile/test/live.test.ts`

**Interfaces:**
- Consumes: the CLI from Task 9, and `resolveProfile` and the client factories from `@mc/profile`.
- Produces: committed profiles and lockfiles that Phase 2 and Phase 3 build from.

- [ ] **Step 1: Write the live test** (it's skipped unless `LIVE=1`)

`packages/profile/test/live.test.ts`:
```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFabricMeta,
  createModrinthClient,
  createMojangMeta,
  parseProfile,
  resolveProfile,
  USER_AGENT,
} from "../src/index";

const live = !!process.env.LIVE;
const http = { fetch: (i: string, init?: RequestInit) => fetch(i, init), userAgent: USER_AGENT };
const clients = { modrinth: createModrinthClient(http), fabric: createFabricMeta(http), mojang: createMojangMeta(http) };

for (const name of ["vanilla-plus", "adventure"]) {
  test.skipIf(!live)(
    `live: ${name} resolves against Modrinth, Fabric and Mojang`,
    async () => {
      const path = join(import.meta.dir, "../../../profiles", `${name}.json`);
      const profile = parseProfile(JSON.parse(readFileSync(path, "utf8")), `${name}.json`);
      const { lock } = await resolveProfile(profile, clients);
      expect(lock.javaMajor).toBe(25);
      expect(lock.files.length).toBeGreaterThan(5);
      for (const f of lock.files) expect(f.url.startsWith("https://cdn.modrinth.com/")).toBe(true);
    },
    120_000,
  );
}
```

- [ ] **Step 2: Write `profiles/vanilla-plus.json`**

```json
{
  "name": "vanilla-plus",
  "description": "Vanilla with performance mods and Vanilla Tweaks. Vanilla clients can join; the modpack only adds optional extras.",
  "minecraft": "26.3",
  "loader": { "fabric": "latest-stable" },
  "memory": { "min": "2G", "max": "4G" },
  "properties": {
    "difficulty": "normal",
    "view-distance": 10,
    "simulation-distance": 8,
    "motd": "Vanilla+ on the tailnet"
  },
  "mods": [
    { "modrinth": "fabric-api", "side": "server" },
    { "modrinth": "lithium", "side": "server" },
    { "modrinth": "ferrite-core", "side": "server" },
    { "modrinth": "c2me-fabric", "side": "server" },
    { "modrinth": "scalablelux", "side": "server" },
    { "modrinth": "vmp-fabric", "side": "server" },
    { "modrinth": "chunky", "side": "server" },
    { "modrinth": "spark", "side": "server" },
    { "modrinth": "simple-voice-chat", "side": "both", "clientOptional": true },
    { "modrinth": "sodium", "side": "client-optional" },
    { "modrinth": "iris", "side": "client-optional" },
    { "modrinth": "immediatelyfast", "side": "client-optional" },
    { "modrinth": "entityculling", "side": "client-optional" },
    { "modrinth": "modmenu", "side": "client-optional" },
    { "modrinth": "appleskin", "side": "client-optional" },
    { "modrinth": "jade", "side": "client-optional" },
    { "modrinth": "xaeros-minimap", "side": "client-optional" },
    { "modrinth": "xaeros-world-map", "side": "client-optional" }
  ],
  "waiting": [],
  "datapacks": [
    "vt:afk-display",
    "vt:armor-statues",
    "vt:cauldron-concrete",
    "vt:double-shulker-shells",
    "vt:durability-ping",
    "vt:fast-leaf-decay",
    "vt:mini-blocks",
    "vt:more-effective-tools",
    "vt:more-mob-heads",
    "vt:painting-picker",
    "vt:player-head-drops",
    "vt:silence-mobs",
    "vt:spectator-conduit-power",
    "vt:spectator-night-vision",
    "vt:track-raw-statistics",
    "vt:track-statistics",
    "vt:unlock-all-recipes",
    "vt:wood-stripper"
  ],
  "resourcePack": { "pack": "vt:resources", "require": false }
}
```

- [ ] **Step 3: Write `profiles/adventure.json`**

```json
{
  "name": "adventure",
  "description": "Structures, storage, backpacks and waystones on top of Vanilla+. Everyone needs the modpack.",
  "minecraft": "26.3",
  "loader": { "fabric": "latest-stable" },
  "memory": { "min": "2G", "max": "6G" },
  "properties": {
    "difficulty": "normal",
    "view-distance": 10,
    "simulation-distance": 8,
    "motd": "Adventure on the tailnet"
  },
  "mods": [
    { "modrinth": "fabric-api", "side": "server" },
    { "modrinth": "lithium", "side": "server" },
    { "modrinth": "ferrite-core", "side": "server" },
    { "modrinth": "c2me-fabric", "side": "server" },
    { "modrinth": "scalablelux", "side": "server" },
    { "modrinth": "vmp-fabric", "side": "server" },
    { "modrinth": "chunky", "side": "server" },
    { "modrinth": "spark", "side": "server" },
    { "modrinth": "clumps", "side": "server" },
    { "modrinth": "universal-graves", "side": "server" },
    { "modrinth": "skinrestorer", "side": "server" },
    { "modrinth": "villagerconfig", "side": "server" },
    { "modrinth": "dungeons-and-taverns", "side": "server" },
    { "modrinth": "incendium", "side": "server" },
    { "modrinth": "nullscape", "side": "server" },
    { "modrinth": "towns-and-towers", "side": "server" },
    { "modrinth": "bartering-station", "side": "both" },
    { "modrinth": "easy-anvils", "side": "both" },
    { "modrinth": "natures-compass", "side": "both" },
    { "modrinth": "storagedrawers", "side": "both" },
    { "modrinth": "toms-storage", "side": "both" },
    { "modrinth": "trade-cycling", "side": "both" },
    { "modrinth": "travelersbackpack", "side": "both" },
    { "modrinth": "waystones", "side": "both" },
    { "modrinth": "underground-villages", "side": "both" },
    { "modrinth": "hammers-and-excavators-miners-dream", "side": "both" },
    { "modrinth": "simple-voice-chat", "side": "both", "clientOptional": true },
    { "modrinth": "jade", "side": "client-optional" },
    { "modrinth": "jei", "side": "client-optional" },
    { "modrinth": "xaeros-minimap", "side": "client-optional" },
    { "modrinth": "badoptimizations", "side": "client-optional" },
    { "modrinth": "sodium", "side": "client-optional" },
    { "modrinth": "iris", "side": "client-optional" }
  ],
  "waiting": [
    "lootr",
    "carry-on",
    "explorify",
    "nether-chested",
    "mrcrayfishs-furniture-mod-tools-refurbished",
    "spiral-tower-villages",
    "medieval-buildings",
    "true-ending"
  ],
  "datapacks": [
    "vt:afk-display",
    "vt:armor-statues",
    "vt:cauldron-concrete",
    "vt:double-shulker-shells",
    "vt:durability-ping",
    "vt:fast-leaf-decay",
    "vt:mini-blocks",
    "vt:more-effective-tools",
    "vt:more-mob-heads",
    "vt:painting-picker",
    "vt:player-head-drops",
    "vt:silence-mobs",
    "vt:spectator-conduit-power",
    "vt:spectator-night-vision",
    "vt:track-raw-statistics",
    "vt:track-statistics",
    "vt:unlock-all-recipes",
    "vt:wood-stripper"
  ],
  "resourcePack": { "pack": "vt:resources", "require": false }
}
```

- [ ] **Step 4: Resolve both profiles against the live APIs**

Run: `bun apps/agent/src/cli.ts profile resolve vanilla-plus && bun apps/agent/src/cli.ts profile resolve adventure`

Expected: two `Resolved …: Minecraft 26.3, Fabric 0.19.5, Java 25, N files …` lines, possibly followed by `warning:` lines for prerelease builds (for example C2ME and ScalableLux are alpha). `adventure` also prints a `Still waiting:` list.

If resolving fails, the message says what to do:
- **A listed mod has no 26.3 build any more:** move it to `waiting`.
- **Two mods are incompatible:** stop and ask the user which to keep. Don't choose silently.
- **A dependency isn't on Modrinth:** stop and ask the user.

Don't edit the lockfile by hand.

- [ ] **Step 5: Review the lockfiles**

Run:
```bash
bun -e 'for (const n of ["vanilla-plus","adventure"]) { const l = JSON.parse(await Bun.file(`profiles/${n}.lock.json`).text()); console.log(n, l.files.length, "files"); for (const f of l.files) console.log(" ", f.side.padEnd(15), f.clientOptional ? "opt" : "   ", f.auto ? "auto" : "    ", f.prerelease ? "pre" : "   ", f.slug) }'
```

Expected:
- `fabric-api` shows as `both`. In `adventure` it's required on the client; in `vanilla-plus` it's client-optional, because only optional mods need it there.
- No `client-optional` mod appears with the side `server`.
- Auto dependencies such as `balm` and `sodium` (pulled in by Iris) are listed.
- Check that every `auto` entry looks plausible. Report anything surprising to the user instead of changing it.

- [ ] **Step 6: Run the live test and the full suite**

Run: `LIVE=1 bun test live && bun test`
Expected: 2 live tests pass, and the offline suite passes too, with the live tests skipped.

- [ ] **Step 7: Commit**

```bash
git add profiles packages/profile/test/live.test.ts
git commit -m "feat(profiles): vanilla-plus and adventure for 26.3 with lockfiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Voice chat port, Fedora end-to-end run, and roadmap

**Files:**
- Modify: `infra/tailscale/policy.hujson`, `ROADMAP.md`, `docs/setup/phase-0.md` (only add a "re-apply the policy" note)
- Create: `docs/setup/phase-1.md` (the manual checklist the user follows)

**Interfaces:**
- Consumes: the `mc-host` CLI and the committed profiles.
- Produces: an updated tailnet policy and a Phase 1 that has been checked by hand.

- [ ] **Step 1: Allow voice chat in the tailnet policy**

Replace the `grants` and `tests` blocks in `infra/tailscale/policy.hujson` with:
```hujson
  "grants": [
    {
      // Players (and admin devices) reach any player's Minecraft server and voice chat.
      "src": ["tag:mc-player", "autogroup:member"],
      "dst": ["tag:mc-player"],
      "ip": ["tcp:25565", "udp:24454"],
    },
  ],

  "tests": [
    {
      "src": "tag:mc-player",
      "proto": "tcp",
      "accept": ["tag:mc-player:25565"],
      "deny": ["tag:mc-player:22", "tag:mc-player:3389", "tag:mc-player:445"],
    },
    {
      // Simple Voice Chat
      "src": "tag:mc-player",
      "proto": "udp",
      "accept": ["tag:mc-player:24454"],
      "deny": ["tag:mc-player:53"],
    },
  ],
```
Keep the existing `tagOwners` block and header comments unchanged.

- [ ] **Step 2: Write `docs/setup/phase-1.md`**

````markdown
# Phase 1: Local test run on Fedora

Run these from the repo root. Nothing here touches your personal tailnet.

## 1. Update the tailnet policy (voice chat)

Open the Minecraft tailnet's admin console, go to **Access controls**, and paste in
`infra/tailscale/policy.hujson`. Then save. The new UDP test must pass.

## 2. Build the tool

```bash
bun install
(cd apps/agent && bun run build)
alias mc-host="$PWD/apps/agent/dist/mc-host"
```

## 3. Build and start the adventure server

```bash
mc-host profile build-server adventure ~/mc-test/adventure --packs ./VanillaTweaks_d471400_UNZIP_ME
mc-host profile run ~/mc-test/adventure
```

- The first run asks you to accept Mojang's EULA. Type `yes`.
- Wait for `Done (…)! For help, type "help"`.
- In the server console, run:
  - `datapack list`: all 18 Vanilla Tweaks packs should be under **enabled**. They're
    26.2 packs, so a "made for an older version" note is fine. If any show as
    **available** instead, run `datapack enable "file/<name>.zip"` and note which ones.
  - `chunky radius 2000`, then `chunky start`, to pre-generate the area around spawn.

## 4. Join through Prism

```bash
mc-host profile build-mrpack adventure ~/mc-test/adventure.mrpack
```

- In Prism, go to **Add Instance → Import**, pick `adventure.mrpack`, keep the optional
  mods ticked, and launch it.
- Go to **Multiplayer → Add Server → `localhost`** and join.
- Check that you can place a Waystone, open a Traveler's Backpack, and see JEI.

## 5. Vanilla client on vanilla-plus

```bash
mc-host profile build-server vanilla-plus ~/mc-test/vanilla-plus --packs ./VanillaTweaks_d471400_UNZIP_ME
mc-host profile run ~/mc-test/vanilla-plus
```

Stop the adventure server first, because both use port 25565. Join `localhost` from a
**plain vanilla 26.3** Prism instance with no mods.

## Done when

- [ ] The policy saved with both tests passing
- [ ] `adventure` boots and all 18 datapacks are enabled
- [ ] Joined `adventure` from the imported `.mrpack`
- [ ] Joined `vanilla-plus` from a vanilla client
- [ ] `Ctrl+C` stops the server cleanly (no crash summary printed)
````

- [ ] **Step 3: Update `ROADMAP.md`**

Tick these Phase 1 items: `Profile schema and lockfile`, `vanilla-plus and adventure profiles`, `Server builder and .mrpack builder`. Then add this line under the Phase 1 heading:
```markdown
Local test guide: [docs/setup/phase-1.md](docs/setup/phase-1.md)
```
Leave `Voice chat port` and `Run adventure locally on Fedora` unticked. The user ticks them after the manual steps.

- [ ] **Step 4: Run the whole suite one last time**

Run: `bun test && bun run typecheck`
Expected: every test passes, with no type errors.

- [ ] **Step 5: Commit and push**

```bash
git add infra/tailscale/policy.hujson docs/setup/phase-1.md ROADMAP.md
git commit -m "chore: voice chat port, phase 1 local test guide

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 6: Hand over to the user**

Ask the user to follow `docs/setup/phase-1.md`, which covers the policy paste, the Prism join and the vanilla join, and to report anything that failed, especially:
- datapacks that weren't enabled
- mods that crashed the server, including the crash summary it printed

Once they confirm, tick the last two Phase 1 items in `ROADMAP.md`.
