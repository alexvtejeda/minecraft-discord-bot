# Local jars — Design

Date: 2026-10-03
Status: Implemented (see [the plan](../plans/2026-10-03-local-jars.md); this spec was updated to match it)
Parent design: [2026-09-25-minecraft-discord-bot-design.md](2026-09-25-minecraft-discord-bot-design.md)
Related: [2026-09-25-phase-1-profiles-design.md](2026-09-25-phase-1-profiles-design.md)

## Goal

Add mods that aren't on Modrinth (for example jars downloaded from CurseForge) to a
profile. Modrinth stays the main source: local jars only fill the gaps. A maintainer adds
a jar from the terminal (`mc-host admin jar add`) or from Discord (`/mod upload`). Either
way the jar is checked, stored in R2 under its sha512, and the command prints a profile
line to paste. The profile in git stays the source of truth, and changes still go
through commit → deploy → `/world repin`.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Scope | Fill gaps only. No CurseForge API, no version or dependency resolution from CurseForge. | Almost every mod is on Modrinth already. Of the 20 jars in `mods/`, 14 were already in `cst.lock.json`. |
| Source of truth | The profile in git holds a reference (`jar`, `filename`, `sha512`, `side`). The bytes live only in R2. | Both entry points (CLI and Discord) produce the same thing, and no binaries go in the repo. |
| Discord's role | `/mod upload` stages the jar and replies with the profile line. It never changes a world. | Changing a live world from Discord would drift from the repo, and the next repin would remove the mod. |
| R2 key | `jars/<sha512>.jar`, plus a row in a D1 `jars` table | Content addressed, so uploading the same jar twice does nothing. |
| Server download | `GET /jars/<sha512>` on the Worker, requires an agent token or the admin secret | The repo and lockfiles are public. Without auth, the Worker would redistribute CurseForge jars to anyone. |
| Client download | The Worker bundles local jars into the `.mrpack` under `overrides/mods/` | Uses the existing `ExtraFile` hook in `packages/profile/src/mrpack.ts`, and doesn't depend on launchers accepting non-Modrinth download URLs. |
| Sides | `server` and `both` only | `.mrpack` overrides can't be marked optional, so `client-optional` and `clientOptional` don't work for local jars. |
| Checks | Rejected: not a valid zip, no `fabric.mod.json`, `minecraft` or `java` range excludes the profile. Hints: entries in `depends`. Final check: `check-packs` boot. | Catches the common mistakes (wrong loader, wrong version, unfinished download) without having to resolve dependencies across sources. |
| Lockfile version | Stays at 1, with an optional `source: "jar"` on entries | Existing lockfiles keep working. Old agents are turned away by raising `MIN_AGENT_VERSION`. |
| Removing a jar | Remove the line and repin. The R2 object stays. | Old snapshot lockfiles still reference it, and rollback needs it. No GC (YAGNI). |

## Profile

A second kind of `mods[]` entry, next to `{ "modrinth": … }`:

```json
{
  "jar": "the-deeper-end",
  "filename": "the-deeper-end-fabric-1.1.1.jar",
  "sha512": "…128 hex…",
  "side": "both"
}
```

- `jar` uses the same slug rules as `modrinth` and is the name shown in `/mod list` and
  repin diffs. The duplicate check covers `modrinth`, `jar` and `waiting` together.
- `filename` must end in `.jar` and can't contain `/`, `\` or `..`.
- `sha512` is 128 lowercase hex characters.
- `side` is `server` or `both`. `clientOptional` and `version` aren't allowed on a `jar`
  entry (strict object).

## `packages/profile`

### `jarcheck.ts` (new)

`inspectJar(bytes: Uint8Array, filename: string, target: { minecraft: string; javaMajor: number }): Promise<JarReport>`

```ts
/** What the Worker records about an uploaded jar. */
interface JarInfo {
  sha512: string;
  sha1: string;
  size: number;
  filename: string;
  modId: string | null;
  version: string | null;
  /** depends.minecraft; array alternatives joined with " || ". */
  minecraftRange: string | null;
  javaRange: string | null;
  /** Dependency mod IDs other than fabricloader, minecraft, java, fabric-api and fabric. */
  depends: string[];
}
interface JarReport extends JarInfo {
  /** Non-empty means reject. Each is a full sentence for the user. */
  problems: string[];
}
```

- The file name must be a plain name ending in `.jar` (spaces are fine).

- If the bytes don't unzip (fflate), the problem is "isn't a valid jar. Was the download
  finished?"
- If there's no `fabric.mod.json`, the problem names the loader it did find:
  `META-INF/neoforge.mods.toml` means NeoForge, `META-INF/mods.toml` means Forge, and
  anything else is "not a Fabric mod". The message tells the user to get the Fabric build.
- If `depends.minecraft` excludes `target.minecraft`, the problem is "built for Minecraft
  <range>, the profile is <version>". The same applies to `depends.java` and
  `target.javaMajor`.
- `depends` values may be a string or an array of strings (Fabric allows both). An array
  matches if any element matches.
- Version ranges: `*`, `=x`, `x` (exact), `>=x`, `>x`, `<=x`, `<x`, `~x` (same
  major.minor), `^x` (same major), `x.x` wildcards, `a || b` alternatives, and
  space-separated combinations (all must match).
  Versions compare numerically per dot-separated part, and missing parts count as 0.
  Anything that doesn't parse becomes a hint, not a problem.
- `sha512` uses the existing `sha512Hex` in `hash.ts`. Add a `sha1Hex` next to it.

### `schema.ts`

`ModEntry` becomes a union of `ModrinthEntry` and `JarEntry`, picked by key (an entry with
`jar` is a jar entry) so mistakes are still reported against the right fields. The
`superRefine` checks use `modName(entry)` for duplicates. Code that reads `m.modrinth`
narrows with `isModrinthEntry`.

### `lockfile.ts`

`LockEntry` gets `source?: "jar"`. For jar entries:

| Field | Value |
|---|---|
| `slug` | the `jar` name |
| `projectId` | `"jar"` |
| `versionId` | first 12 hex characters of `sha512` |
| `versionNumber` | `fabric.mod.json` version, or `"unknown"` |
| `url` | `jars/<sha512>` (relative to the Worker URL) |
| `sha1`, `sha512`, `size` | from the `jars` row |
| `clientOptional`, `auto`, `prerelease` | `false` |

`parseLock` accepts the field. `modDiff` in `world-repin.ts` already compares `versionId`,
so a changed jar shows up as changed.

### `resolve.ts`

`resolveProfile` takes a new client, `jars: { lookup(sha512): Promise<JarInfo | null> }`.
Jar entries skip Modrinth. A `null` lookup fails with
"<jar>: sha512 <first 12> isn't uploaded. Run "mc-host admin jar add <profile> <filename>"."
A lookup whose recorded `minecraft_range` excludes the profile's version fails the same
way `inspectJar` would. Modrinth dependency resolution ignores jar entries. If a jar's
`modId` equals the slug of a resolved Modrinth file, that's a warning: "<jar> may
duplicate Modrinth <slug>".

### `mrpack.ts`

`mrpackIndex` leaves out `source: "jar"` entries. `buildMrpack` callers pass their bytes
as `extras` with path `mods/<filename>`. `isVanillaCompatible` is unchanged: a jar entry
with side `both` already makes the pack non-vanilla.

## Worker

### Migration `0003_jars.sql`

```sql
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
  uploaded_by TEXT NOT NULL,   -- Discord user ID, or "admin" for the CLI
  uploaded_at INTEGER NOT NULL
);
```

`java_range` and `depends_json` let `GET /admin/jars/<sha512>` return the same `JarInfo`
that `inspectJar` produced.

### Admin API (admin token)

- `PUT /admin/jars/<sha512>?filename=&minecraft=&java=` with the jar as the raw body.
  Jars are small (the largest so far is 6 MB), so one request is enough and there's no
  half-finished state. The Worker checks the body against the sha512 in the path
  (`upload_missing`, 409, on a mismatch), runs `inspectJar` against the given Minecraft
  and Java versions, and answers `bad_request` (400) with the problems. A jar that's
  already stored is still checked against the new target, then answers 200 with
  `created: false`. A new one goes to R2 first, then the row, and answers 201.
- `GET /admin/jars/<sha512>` returns the row (`JarInfo`) or 404.

### Download API (agent token or admin secret)

- `GET /jars/<sha512>` streams `jars/<sha512>.jar` from R2, for a hosting token or the
  admin secret (maintainers also build servers on their own PC). 404 if it isn't there.

### `/mod upload`

`/mod upload jar:<file> side:<server|both> [name:<name>]`, maintainer-only.

1. Defer the reply, since the download and check may take longer than 3 seconds.
2. Reject anything that isn't `.jar`, or is larger than 32 MB (`MAX_JAR_BYTES`, shared
   with the CLI path), before fetching. With no active world, the reply points to
   `mc-host admin jar add` instead.
3. Fetch the attachment URL and run `inspectJar` against the active world's Minecraft
   and Java versions.
4. If there are problems, reply with them and store nothing.
5. Otherwise put the jar in R2 (skipped if the row exists), insert the row, and reply
   (ephemeral) with the profile line in a code block plus any dependency hints.

### `.mrpack` and `/mod list`

- `worldMrpack` reads each `source: "jar"` entry's object from `env.BUCKET` and passes it
  as an extra. A missing object is a 500 with a log line naming the sha512.
- `/mod list` tags jar entries "(uploaded)".

### Agent version

Raise the `MIN_AGENT_VERSION` env var to the release that understands relative `jars/` URLs.

## Agent (`mc-host`)

- `mc-host admin jar add <profile> <file.jar> [--side server|both] [--name <jar>]`
  - Runs `inspectJar` locally first, against the profile's Minecraft version and the Java
    that Mojang's metadata gives for it. Prints the problems and stops if there are any.
  - Uploads, and prints the profile line plus dependency hints.
  - `--name` defaults to the mod ID, lowercased and normalized to slug characters.
  - `--side` defaults to `both`.
- `mc-host profile resolve` builds the `jars` client from the admin API.
- `server/build.ts`: a `source: "jar"` entry's URL is resolved against the Worker URL and
  fetched with the agent token (or, for local builds, the admin secret). The existing
  sha512 check applies. A lock with jars and no credentials fails before the server
  folder is touched, naming the env vars to set.
- `profile build-mrpack` downloads the jars the same way and bundles them as overrides.
- `profile check-packs`: also scans the boot log for Fabric's "Incompatible mods found!"
  or missing-dependency block and reports each item it lists. `--packs` is optional, and a
  profile with no datapacks gets a single "mods only" boot.

## Errors and edge cases

| Situation | Result |
|---|---|
| NeoForge/Forge-only jar | Rejected, naming the loader found |
| `minecraft` range excludes the profile (`=26.1.2` vs 26.3) | Rejected with both versions |
| Partial download or corrupt zip | Rejected: "isn't a valid jar" |
| The same jar uploaded twice | No upload or new row. Prints the existing line |
| Profile line references an unknown sha512 | `profile resolve` fails, suggesting `jar add` |
| Jar's mod ID matches a Modrinth slug in the lock | Warning at resolve |
| Discord attachment too large | Discord or the 32 MB check rejects it, and the reply points to the CLI |
| R2 object exists but has no row (upload interrupted) | Run `jar add` again. It's idempotent |
| Jar removed from the profile | Repin as usual. The R2 object and row stay |

## Testing

- `jarcheck`: jars built in memory with fflate (Fabric, NeoForge-only, Forge-only, not a
  zip, each range form, string and array `depends`, `depends` hints). No real CurseForge
  jars in the repo.
- `schema`: union parsing, duplicates across `modrinth`/`jar`/`waiting`, a `jar` entry
  rejected with `client-optional` or `clientOptional`, filename and sha512 format.
- `resolve`: fake `jars` client for a hit, a miss, and a range mismatch, with mixed
  local and Modrinth mods, plus the duplicate-mod-ID warning.
- `mrpack`: jar entries go to `overrides/mods/`, stay out of `files[]`, and the output is
  byte-identical for the same input.
- Worker vitest: upload (pass and fail) → lookup → download with and without a token. `/mod upload` with a mocked attachment fetch. `.mrpack` contains the
  override.
- Agent: `build.ts` resolves the relative URL and sends the token.
- Manual: `jar add` the six new jars in `mods/`. Expected: bosslike-ender-dragon and
  the-deeper-end pass; alexsmobs passes with a `citadel` hint; lootintegrations_vanilla
  passes with a `lootintegrations` hint; more_mobs passes (and moves out of `cst`'s
  `waiting` list); world-bosses is rejected (Minecraft `=26.1.2`).
  Then resolve `cst`, run `check-packs`, and join through Prism.

## Out of scope

- CurseForge API lookups and dependency resolution
- Garbage collection of unused jars in R2
- Local jars that players can untick in the launcher
- Adding mods to a live world without a repin
