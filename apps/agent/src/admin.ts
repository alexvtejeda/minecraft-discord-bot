import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { dependencyHints, inspectJar, jarName, jarProfileLine, modName, UserError } from "@mc/profile";
import type { Command } from "./cli";
import { clientsFor, loadLock, loadProfile, type Deps } from "./commands";
import { createAdminApi, hhmm, type AdminApi } from "./host/api";
import { loadAdminConfig } from "./host/config";
import { mb } from "./host/deps";
import { zipSnapshot } from "./host/snapshot";
import { uploadFile } from "./host/transfer";

type AdminCommand = Extract<Command, { kind: "admin-world-create" | "admin-token-mint" | "admin-lease-release" | "admin-status" | "admin-jar-add" }>;

function today(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function createWorld(cmd: Extract<AdminCommand, { kind: "admin-world-create" }>, api: AdminApi, deps: Deps): Promise<void> {
  const { profile } = await loadProfile(cmd.profilesDir, cmd.profile);
  const lock = await loadLock(cmd.profilesDir, cmd.profile, profile);
  const levelName = String(profile.properties["level-name"] ?? "world");
  if (cmd.importDir && !existsSync(join(cmd.importDir, levelName, "level.dat"))) {
    throw new UserError(
      `${cmd.importDir} doesn't look like a server folder: there's no ${levelName}/level.dat inside it. ` +
        `Point --import at the folder the server ran in (the one that contains ${levelName}/).`,
    );
  }
  const name = cmd.name ?? `${profile.name}-${today((deps.now ?? Date.now)())}`;
  const world = await api.createWorld({ name, profile, lockfile: lock, replace: cmd.replace, imported: Boolean(cmd.importDir) });
  deps.log(`Created ${world.name} from the ${profile.name} profile (Minecraft ${lock.minecraft}). It's the active world now.`);
  if (!cmd.importDir) return;

  const file = join(deps.cacheDir, "import", `${world.id}.zip`);
  try {
    const zipped = await zipSnapshot(cmd.importDir, levelName, file);
    const target = await api.importUrl(world.id, zipped);
    await uploadFile(deps.fetch, target, file);
    await api.importCommit(world.id, { key: target.key, ...zipped });
    deps.log(`Imported ${cmd.importDir} as rev 1 (${mb(zipped.size)} MB).`);
  } catch (err) {
    throw new UserError(
      `${world.name} was created, but importing ${cmd.importDir} failed: ${(err as Error).message} ` +
        "Fix the problem, then run the command again with --replace --name <a new name>.",
    );
  } finally {
    await rm(file, { force: true });
  }
}

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
  // Mods the lockfile already pulls in need no hint. A missing or stale lockfile just means more hints.
  const have = await loadLock(cmd.profilesDir, cmd.profile, profile).then((l) => l.files.map((f) => f.slug), () => profile.mods.map(modName));
  for (const h of dependencyHints(jar.depends, have)) deps.log(h);
}

export async function runAdmin(cmd: AdminCommand, deps: Deps): Promise<void> {
  const cfg = await loadAdminConfig(deps.env ?? process.env, deps.configDir);
  const api = createAdminApi({ ...cfg, fetch: deps.fetch });
  switch (cmd.kind) {
    case "admin-world-create":
      return createWorld(cmd, api, deps);
    case "admin-jar-add":
      return addJar(cmd, api, deps);
    case "admin-token-mint": {
      const token = await api.mintToken({ discordId: cmd.discordId, name: cmd.name });
      deps.log(`Hosting token for ${cmd.name}: ${token}`);
      deps.log("It's shown only once. Send it to them privately. Minting again replaces it.");
      return;
    }
    case "admin-lease-release": {
      const released = await api.releaseLease();
      deps.log(released ? `Released ${released.name}'s lease (they were hosting at ${released.hostAddress}).` : "Nobody was hosting.");
      return;
    }
    case "admin-status": {
      const s = await api.status();
      deps.log(
        s.world
          ? `World: ${s.world.name} (Minecraft ${s.world.minecraft}), rev ${s.world.latestRev}` +
              (s.world.latestAt ? ` saved at ${new Date(s.world.latestAt).toLocaleString()}` : "") +
              (s.world.pregenDone ? "" : ", not pre-generated yet")
          : "No world is active.",
      );
      deps.log(
        s.lease
          ? `Hosting: ${s.lease.name} at ${s.lease.hostAddress} since ${hhmm(s.lease.claimedAt)} (lease until ${hhmm(s.lease.expiresAt)})`
          : "Hosting: nobody",
      );
      deps.log(`Tokens: ${s.users.map((u) => (u.revoked ? `${u.name} (revoked)` : u.name)).join(", ") || "none"}`);
      return;
    }
  }
}
