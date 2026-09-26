# Phase 2b: Managed Java and datapack checks — Design

Date: 2026-09-26
Status: Approved design
Parent design: [2026-09-25-minecraft-discord-bot-design.md](2026-09-25-minecraft-discord-bot-design.md)
Previous phase: [2026-09-26-phase-2a-hosting-design.md](2026-09-26-phase-2a-hosting-design.md)

## Goal

Every host runs Minecraft on a Java runtime the agent downloads itself, chosen by the
world's Minecraft version, so a release that needs a newer Java works without anyone
installing anything or rebuilding the Docker image. The maintainer gets
`mc-host profile check-packs`, which boots a throwaway server with a set of datapacks and
names the packs that break it.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Where the managed JRE is used | Every host, Docker included. The Docker image no longer ships Java. | One code path. It gets exercised on Fedora long before a friend runs it on Windows, and a Java bump needs no image rebuild. |
| What gets downloaded | Adoptium's latest GA Temurin **JRE** for the major in `lock.javaMajor`, verified by the SHA-256 the API returns | The lockfile already records the major Mojang requires. A JRE is all a server needs. No exact build is pinned. |
| Which Java runs | The managed JRE, always. `MC_JAVA=<path>` overrides it. | A system Java that happens to be on PATH doesn't decide anything. The override is for debugging. |
| When it's downloaded | Before the lease is claimed | A slow or failed download never holds the world. |
| Datapack check style | A smoke boot of the real server, not a static `pack_format` comparison | Phase 1's Vanilla Tweaks breakage was parse errors and cross-pack loot-table references. A format-number check would have missed it. |
| When the check runs | Only when the maintainer runs `mc-host profile check-packs` | Hosting and `build-server` stay fast. Friends don't have pack zips before the "datapacks in R2" work anyway. |
| A failing pack | The command reports it and exits 1. Nothing is dropped or changed. | The maintainer decides what to do about it. |

## Part 1: Managed JRE

### Module

`apps/agent/src/java/runtime.ts`:

```ts
ensureJava(major: number, o: {
  cacheDir: string;
  fetch: Fetch;
  userAgent: string;
  log: (line: string) => void;
  platform?: NodeJS.Platform; // default process.platform
  arch?: string;              // default process.arch
}): Promise<string>           // absolute path to bin/java or bin/java.exe
```

The existing `parseJavaMajor`/`javaMajor` in `apps/agent/src/run/java.ts` move to
`apps/agent/src/java/version.ts`. `requireJava` stays for the `MC_JAVA` override path.

### Steps

1. `dir = <cacheDir>/java/<major>`. If `dir/.complete` exists and `javaMajor(dir/bin/java)`
   returns `major`, return that path. If the marker exists but the check fails, delete `dir`
   and carry on as if it were missing.
2. Map the platform to Adoptium's names: `linux`/`win32` → `linux`/`windows`,
   `x64`/`arm64` → `x64`/`aarch64`. Anything else throws a `UserError` naming the
   platform.
3. `GET https://api.adoptium.net/v3/assets/latest/<major>/hotspot?os=<os>&architecture=<arch>&image_type=jre&vendor=eclipse`.
   Take `[0].binary.package` → `{ name, link, checksum }`. An empty array means there's
   no build for this platform. That's a `UserError`.
4. Download `link` with the existing `fetchVerified`, checking the SHA-256 `checksum`. Log
   `Downloading Java <major> (<size> MB)…` first.
5. Delete any leftover `<major>.tmp/`, then extract into it: `.zip` through the fflate
   unzip already used for snapshots, `.tar.gz` through the system `tar -xzf` (which keeps
   the executable bits). The archive holds one top-level folder (`jdk-25.0.4.1+1-jre/`);
   its contents become `<major>.tmp/`.
6. Check that `<major>.tmp/bin/java(.exe)` reports `major`, rename `<major>.tmp` to
   `<major>`, and write `<major>/.complete`.

The cached archive in the download cache is not deleted, so a corrupt extract can be
redone without downloading again.

### Wiring

- `SessionDeps.checkJava(marker)` becomes `ensureJava(major) => Promise<string>`.
  `prepare.ts` calls it with `lock.javaMajor` (the lockfile comes from the manifest)
  right after the EULA prompt and before claiming the lease. The server build still
  happens after the claim, as today. The returned path is carried in `Prepared` and
  passed to `launch(dir, marker, javaBin)`.
- `host/commands.ts` and the Phase 1 `mc-host profile run` both resolve Java the same
  way: `MC_JAVA` if set (checked with `requireJava`), otherwise `ensureJava`.
- `infra/docker/Dockerfile` uses `debian:stable-slim` with `ca-certificates` and `tar`
  installed. `XDG_CACHE_HOME=/data/cache` already sits on the persistent volume, so the
  JRE downloads once per Java major.

### Errors

- Network failure, an Adoptium error, or a checksum mismatch: "Couldn't download Java
  <major> for this PC (<reason>). Check your internet and run `mc-host start` again."
  Checksum mismatches are retried the same way as other failed downloads.
- No build for this platform: "There's no Java <major> download for <os>/<arch>. Set
  MC_JAVA to a Java <major> install to host from this PC."
- Extraction or version-check failure: the `.tmp` folder is deleted and the error names
  the step.

### Tests

Unit tests with a fake fetch and small `.zip` and `.tar.gz` fixtures holding a stub
`bin/java` script that prints a version:

- a cache hit with no network calls
- a download, verify, extract and rename from an empty cache
- a checksum mismatch that leaves no `<major>` folder
- a stale `<major>.tmp/` from an interrupted run that gets cleaned up
- a `.complete` marker whose binary reports the wrong major, which gets re-downloaded
- an unsupported platform, and an empty Adoptium response

Manual: `mc-host start` in Docker on Fedora from an empty cache.

## Part 2: `mc-host profile check-packs`

### Command

```
mc-host profile check-packs <profile> --packs <dir> [--all] [--keep]
```

- Without `--all`, the packs are the profile's `datapacks`, matched with `matchPacks`.
  Missing packs are an error, as in `build-server`.
- With `--all`, every `.zip` in `--packs` is checked, whether the profile lists it or not.
  This is for trying out new pack releases before adding them to a profile.
- With `--keep`, the scratch folder stays around for debugging; otherwise it's deleted.
- The profile still decides the Minecraft version and the mods. Packs can depend on modded
  content, so a vanilla boot would give wrong answers.

### Steps

1. **Index packs.** For each zip, list its `data/<namespace>/<type>/<path>` entries into a
   map from resource id (`namespace:path`) to pack filenames.
2. **Build a scratch server** in `<cacheDir>/check-packs/<profile>/` with `buildServer`,
   using the profile's lockfile and cached downloads, and then override
   `level-name=check` and `level-type=minecraft:flat` in `server.properties`. Copy the packs
   into `check/datapacks/` and accept the EULA there.
3. **Boot.** Launch with `ensureJava`. Capture the log. When a line contains `Done (`,
   send `stop`. Kill the process after 3 minutes.
4. **Scan.** `logscan.ts` pulls out the datapack errors: ERROR/WARN lines about failing to
   parse, load or reload data; `Failed to load datapacks`; and notices that a pack is
   `incompatible`. A non-zero exit or a missing `Done (` line is also a failure.
5. **Attribute.** An error line names a pack when it contains the pack's filename (`file/<name>.zip`)
   or a resource id the index maps to that pack. A resource id that several packs provide
   blames all of them.
6. **Isolate.** If any error remains unattributed, wipe `check/` and boot again with each
   pack alone. Packs that fail alone are named with their own errors. If every pack passes
   alone, report "These packs only fail together" with the unattributed log lines. There's
   no search for the exact combination.

### Output

```
Checking 10 datapacks against adventure (Minecraft 26.3.1)…
  ok    afk display v1.1.17 (MC 26.2).zip
  FAIL  more effective tools v1.0.11 (MC 26.2).zip
        [Server thread/ERROR]: Couldn't parse element vt:…
        …
2 of 10 packs would stop the server from starting.
```

At most 3 log lines per pack. The exit code is 1 if anything failed, 0 otherwise.

### Code layout

```
apps/agent/src/packs/
  index.ts     zip → namespaces and resource ids
  logscan.ts   pure: log lines → { errors, blamed: Map<pack, lines>, unattributed }
  check.ts     orchestration; the boot is injected so tests don't run Java
```

`check.ts` reuses `buildServer`, `ensureEula`, `javaCommand` and the existing process
spawning, not new copies of them.

### Tests

- `logscan`: fixtures made from real logs. Boot 26.3 with today's Vanilla Tweaks 26.2
  zips in `datapacks/`, which are known to break, and save the log excerpts. Also cover a
  clean log.
- `index`: a small zip fixture with two namespaces.
- `check`: a fake boot that returns scripted logs, covering a pack that fails alone,
  errors that only happen with packs combined, a timeout without `Done (`, and a clean run.
- Acceptance: `mc-host profile check-packs adventure --packs datapacks --all` names the
  broken VT 26.2 packs.

## Carried over from 2a

Manual checklist items for the end of 2b:

- Autosave bumps the snapshot rev.
- A fresh world with `admin world create --replace`, whose first start runs Chunky
  pre-generation. This now runs on the managed JRE in the slim image, so it covers Part 1
  as well.

## Docs

- `docs/setup/phase-2.md`: the first start downloads about 58 MB of Java; a new
  "Checking datapacks" section.
- `ROADMAP.md`: 2b becomes "Managed JRE on every host (Docker included)" and
  "`mc-host profile check-packs` smoke boot".

## Out of scope

- A static `pack_format` check, and any automatic check inside `build-server`
- Datapacks and resource packs in R2 (Later)
- `install.ps1` and prebuilt Windows binaries (Phase 4)
- Pinning an exact JRE build
