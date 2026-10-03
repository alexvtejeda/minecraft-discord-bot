import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { USER_AGENT, UserError } from "@mc/profile";
import type { Command } from "../cli";
import { loadLock, loadProfile, localJarSource, type Deps } from "../commands";
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
  // packFiles only returns files when --packs was given.
  const packs = await Promise.all(files.map((f) => indexPack(cmd.packsDir!, f)));

  const dir = join(deps.cacheDir, "check-packs", profile.name);
  await mkdir(dir, { recursive: true });
  if (!(await ensureEula({ configDir: deps.configDir, serverDir: dir, ask: deps.ask, log: deps.log }))) {
    throw new UserError("You need to agree to the EULA to check datapacks.");
  }
  deps.log(files.length ? `Checking ${files.length} datapacks against ${profile.name} (Minecraft ${lock.minecraft})…` : `Checking ${profile.name}'s mods (Minecraft ${lock.minecraft})…`);
  // The server files stay between checks; only the world is thrown away.
  await buildServer({
    profile: {
      ...profile,
      datapacks: [],
      // Its own port, so the check also works on a PC that's hosting the real world right now.
      properties: { ...profile.properties, "level-name": LEVEL, "level-type": "minecraft:flat", "server-port": await freePort() },
    },
    lock,
    dir,
    force: true,
    fetch: deps.fetch,
    cacheDir: deps.cacheDir,
    userAgent: USER_AGENT,
    jarSource: await localJarSource(deps, lock),
  });
  const javaBin = await javaFor(lock, { cacheDir: deps.cacheDir, fetch: deps.fetch, userAgent: USER_AGENT, log: deps.log, override: deps.javaBin });
  const logsDir = join(dir, "check-logs");
  await rm(logsDir, { recursive: true, force: true });
  const boot = createBoot({ serverDir: dir, levelName: LEVEL, packsDir: cmd.packsDir ?? dir, javaBin, marker: await readMarker(dir), logsDir });

  let passed = false;
  try {
    const { lines, summary, ok } = formatReport(await checkPacks(packs, boot, deps.log));
    for (const line of lines) deps.log(line);
    if (cmd.keep) deps.log(`The test world and the boot logs are in ${dir}.`);
    if (!ok) throw new UserError(summary);
    deps.log(summary);
    passed = true;
  } finally {
    if (!cmd.keep) {
      await rm(join(dir, LEVEL), { recursive: true, force: true });
      // A failed check keeps its logs: they're the only record of why a boot failed.
      if (passed) await rm(logsDir, { recursive: true, force: true });
      else if (existsSync(logsDir)) deps.log(`The boot logs are in ${logsDir}.`);
    }
  }
}

/** A TCP port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function packFiles(cmd: Extract<Command, { kind: "check-packs" }>, datapacks: string[]): Promise<string[]> {
  if (!cmd.all && !datapacks.length) return [];
  if (!cmd.packsDir) {
    throw new UserError(cmd.all ? "--all needs --packs <folder>." : `${cmd.name} has ${datapacks.length} datapacks. Add --packs <folder> pointing at their zips.`);
  }
  if (!existsSync(cmd.packsDir)) throw new UserError(`The --packs folder ${cmd.packsDir} doesn't exist. Check the path and try again.`);
  const names = await readdir(cmd.packsDir);
  if (cmd.all) {
    const zips = names.filter((n) => n.toLowerCase().endsWith(".zip")).sort();
    if (!zips.length) throw new UserError(`There are no .zip files in ${cmd.packsDir}.`);
    return zips;
  }
  const { found, missing } = matchPacks(datapacks, names);
  if (missing.length) {
    throw new UserError(`These datapacks aren't in ${cmd.packsDir}: ${missing.join(", ")}. Add their zips, or remove them from the profile.`);
  }
  return [...found.values()].sort();
}
