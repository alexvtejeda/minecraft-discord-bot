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
- With `--keep`, the scratch world and per-boot logs stay around for debugging.
- The profile still decides the Minecraft version and the mods. Packs can depend on modded
  content, so a vanilla boot would give wrong answers.

### What a real failure looks like

A trial boot of `adventure` (26.3) with the ten Vanilla Tweaks 26.2 packs, on 2026-09-26,
shaped this part. The logs are kept as test fixtures in `apps/agent/test/fixtures/packs/`.

- **Mods log errors with no packs at all.** `nova_structures` logs `Failed to load function …`
  and something logs `No key layers in MapLike[{}]` on every boot. The server starts anyway.
- **The breaking error names no pack.** It's a `Registry loading errors:` block ending in
  `Unbound values in registry ResourceKey[minecraft:root / minecraft:loot_table]: [graves:entities/player, more_mob_heads:entities/shulker]`,
  followed by `Failed to load datapacks, can't proceed with server load`. Those loot tables
  are *referenced* by `player head drops` and `double shulker shells` (they're meant for
  packs that aren't installed). No pack provides them.
- **One fatal error hides the rest.** Loading stops at the first registry failure.
- Without those two packs, the other eight load cleanly: the only errors are the ones the
  no-pack boot also has.

### Steps

1. **Index packs.** For each zip, record its entry paths and the text of its `.json`,
   `.mcfunction` and `.mcmeta` files.
2. **Scratch server.** Build the profile into `<cacheDir>/check-packs/<profile>/` with
   `buildServer`, with `datapacks: []` and the properties overridden to
   `level-name=check` and `level-type=minecraft:flat`. The server files stay there between
   runs so later checks don't download anything; only the `check/` world is wiped before
   each boot. The EULA is asked for the same way as `profile run`.
3. **Boot** (repeated below). Wipe `check/`, copy the chosen packs into `check/datapacks/`,
   launch with the managed Java and capture stdout. When a line contains `Done (`, send
   `stop`. Kill the process if it hasn't reached `Done (` or exited after 3 minutes, or
   hasn't exited 1 minute after `stop`. Each boot's log is written to
   `check-logs/<n>-<label>.log` in the scratch folder.
4. **Scan.** An error is an `ERROR` line, or a `WARN` line about data packs, failed loads,
   parsing, or an incompatible pack, together with its continuation lines, leaving out
   stack frames (`at …`, `... N more`). `Failed to load datapacks, can't proceed` is not an
   error of its own; it, a missing `Done (`, or a timeout means the boot **didn't start**.
5. **Baseline.** The first boot has no packs. If it doesn't start, stop and say the server
   is broken without any datapacks, with its last errors. Otherwise its errors are the
   baseline: an error in a later boot whose text (without the timestamp and thread) matches
   a baseline error is ignored.
6. **Attribute.** For each new error line, collect its resource ids (`namespace:path`) and
   `file/<name>.zip` mentions. A pack is blamed when the line names its file, when it
   provides an id (it has `data/<namespace>/…/<path>.<ext>`), or when its text mentions an
   id whose namespace isn't `minecraft`. `minecraft:` ids are too common in pack files to
   count as mentions.
7. **Repeat.** Boot all packs. If the boot starts with no new errors, stop. If some packs
   were blamed, mark them failed with the lines that blamed them, and boot again without
   them. This is how failures hidden behind a fatal error come out.
8. **Isolate.** If a boot has new errors (or doesn't start) but blames no pack, boot each
   remaining pack alone. Packs that fail alone are marked failed. If some did, go back to
   step 7 with the rest. If none did, report "These packs only fail together" with the
   unattributed lines, and stop. There's no search for the exact combination.

### Output

```
Checking 10 datapacks against adventure (Minecraft 26.3)…
  ok    afk display v1.1.17 (MC 26.2).zip
  FAIL  double shulker shells v1.3.17 (MC 26.2).zip
        java.lang.IllegalStateException: Unbound values in registry ResourceKey[minecraft:root / minecraft:loot_table]: [graves:entities/player, more_mob_heads:entities/shulker]
  …
2 of 10 datapacks have errors. Logs: <scratch>/check-logs (3 boots)
```

At most 3 lines per pack, each cut to 300 characters. The exit code is 1 if anything
failed, 0 otherwise. The scratch world and logs are deleted at the end unless `--keep` is
given; the server files stay.

### Code layout

```
apps/agent/src/packs/
  index.ts     zip → entry paths and text
  logscan.ts   pure: log lines → errors and "started"; baseline filtering; attribution
  check.ts     the boot loop from steps 5–8; the boot is injected so tests don't run Java
  boot.ts      the real boot: scratch world, packs, Java, timeouts, log capture
  command.ts   mc-host profile check-packs
```

`check.ts` reuses `buildServer`, `ensureEula`, `javaCommand` and the existing process
spawning, not new copies of them.

### Tests

- `logscan`: the three real logs in `apps/agent/test/fixtures/packs/` (no packs, all ten
  packs, and the eight clean ones).
- `index`: a small zip fixture with two namespaces.
- `check`: a fake boot that returns scripted logs, covering a pack that fails alone,
  errors that only happen with packs combined, a timeout without `Done (`, and a clean run.
- Acceptance: `mc-host profile check-packs adventure --packs datapacks --all` fails
  exactly `player head drops` and `double shulker shells`, and passes the other eight.

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
