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
