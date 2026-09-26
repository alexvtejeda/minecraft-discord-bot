import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseLock, parseProfile, UserError } from "@mc/profile";
import type { Manifest } from "@mc/protocol";
import type { ServerMarker } from "../server/build";
import { hhmm } from "./api";
import { mb, yes, type SessionDeps } from "./deps";
import { lastSaveTime, moveToRecovered, readState, serverDirFor, writeState } from "./state";
import { fetchSnapshot, uploadSnapshot } from "./sync";

export interface Prepared {
  world: Manifest["world"];
  sessionId: string;
  baseRev: number;
  serverDir: string;
  levelName: string;
  marker: ServerMarker;
  pregenDone: boolean;
  address: string;
  /** Remove prepare's Ctrl+C handler; the run phase installs its own. */
  unhook: () => void;
}

/**
 * Before claiming: if this PC's last session never finished uploading, decide whether its copy
 * can become the next rev (returns true) or must be set aside in recovered/ (returns false).
 */
async function recoveryCheck(deps: SessionDeps, manifest: Manifest, levelName: string): Promise<boolean> {
  const state = await readState(deps.dataDir);
  if (!state?.dirty) return false;
  const setAside = async (why: string) => {
    const dest = await moveToRecovered(deps.dataDir, state.worldId, deps.now());
    await writeState(deps.dataDir, { ...state, dirty: false });
    deps.log(dest ? `${why} Your copy was moved to ${dest} and won't be uploaded.` : why);
    return false;
  };
  if (state.worldId !== manifest.world.id) return setAside("Your last session was for a world that isn't active anymore.");
  const latestRev = manifest.latest?.rev ?? 0;
  if (latestRev !== state.baseRev) {
    return setAside(`Your last session didn't finish uploading, and someone has hosted since (the world is now at rev ${latestRev}).`);
  }
  if (manifest.lease && !manifest.lease.you) {
    return setAside(`Your last session didn't finish uploading, and ${manifest.lease.name} is hosting right now.`);
  }
  const saved = await lastSaveTime(serverDirFor(deps.dataDir, state.worldId), levelName);
  const answer = await deps.ask(
    `Your last session didn't finish uploading (last save ${saved === null ? "unknown" : hhmm(saved)}). Upload it now? [Y/n] `,
  );
  if (yes(answer, true)) return true;
  return setAside("Okay, it won't be uploaded.");
}

export async function prepare(deps: SessionDeps): Promise<Prepared> {
  const manifest = await deps.api.manifest();
  const { world } = manifest;
  const profile = parseProfile(manifest.profile, `the ${world.name} profile`);
  const lock = parseLock(JSON.stringify(manifest.lockfile), `the ${world.name} lockfile`);
  const levelName = String(profile.properties["level-name"] ?? "world");
  const serverDir = serverDirFor(deps.dataDir, world.id);

  let uploadLocal = await recoveryCheck(deps, manifest, levelName);
  await mkdir(serverDir, { recursive: true });
  // Ask about the EULA before claiming, so nobody holds the lease while reading it.
  if (!(await deps.ensureEula(serverDir))) throw new UserError("You need to agree to the EULA to host a server.");

  const address = deps.address();
  const claim = await deps.api.claim(address);
  const release = () => deps.api.release(claim.sessionId).catch(() => {});
  const unhook = deps.onStopSignal(() => {
    deps.log("Cancelled. Releasing the lease…");
    void release().then(() => deps.exit(130));
  });
  try {
    let baseRev = claim.baseRev;
    if (uploadLocal && baseRev !== (await readState(deps.dataDir))?.baseRev) {
      const dest = await moveToRecovered(deps.dataDir, world.id, deps.now());
      deps.log(`Someone uploaded a newer world a moment ago, so your copy was moved to ${dest} instead.`);
      uploadLocal = false;
    }
    if (uploadLocal) {
      deps.log("Uploading the world from your last session…");
      baseRev = await uploadSnapshot(deps, { sessionId: claim.sessionId, baseRev, serverDir, levelName, pregenDone: manifest.pregenDone });
      deps.log(`Uploaded as rev ${baseRev}.`);
    } else if (baseRev > 0) {
      const state = await readState(deps.dataDir);
      const upToDate = state?.worldId === world.id && state.baseRev === baseRev && existsSync(join(serverDir, levelName));
      if (!upToDate) {
        const latest = manifest.latest?.rev === baseRev ? manifest.latest : (await deps.api.manifest()).latest;
        if (!latest || latest.rev !== baseRev) throw new UserError("The world changed while starting. Run mc-host start again.");
        deps.log(`Downloading ${world.name} rev ${baseRev} (${mb(latest.size)} MB)…`);
        await fetchSnapshot(deps, latest, serverDir, levelName);
      }
    }
    await writeState(deps.dataDir, { worldId: world.id, baseRev, dirty: false });
    if (profile.datapacks.length || profile.resourcePack) {
      deps.log("Note: datapacks and the resource pack aren't supported yet, so this world runs without them.");
    }
    // Writes eula.txt again in case the folder was just moved aside and recreated.
    await deps.ensureEula(serverDir);
    const marker = await deps.build({ profile: { ...profile, datapacks: [] }, lock, dir: serverDir });
    deps.checkJava(marker);
    return { world, sessionId: claim.sessionId, baseRev, serverDir, levelName, marker, pregenDone: manifest.pregenDone, address, unhook };
  } catch (err) {
    unhook();
    await release();
    throw err;
  }
}
