import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError, type Fetch } from "@mc/profile";
import { fetchVerified } from "../download";
import { sha256File } from "../host/snapshot";
import { mergeProperties } from "../server/properties";

/**
 * The Paper build the lobby runs, from https://fill.papermc.io/v3/projects/paper/versions/26.3/builds.
 * 26.3 has only beta builds so far; move to a stable one when it ships.
 */
export const PAPER = {
  minecraft: "26.3",
  javaMajor: 25,
  build: 147,
  url: "https://fill-data.papermc.io/v1/objects/e88207b474f1954f4de175a0b63a3d574e995f609d7fd9c4960d4f76e1784ae3/paper-26.3-147.jar",
  sha256: "e88207b474f1954f4de175a0b63a3d574e995f609d7fd9c4960d4f76e1784ae3",
};
export type PaperBuild = typeof PAPER;

export const PAPER_JAR = "paper.jar";
export const BRIDGE_JAR = "lobby-bridge.jar";

/** Only written for a lobby with no server.properties yet; after that the file is the maintainer's (except FORCED_PROPERTIES). */
export const LOBBY_PROPERTIES: Record<string, string | number | boolean> = {
  motd: "Lobby: /play joins whoever is hosting",
  "level-type": "minecraft:flat",
  "generate-structures": false,
  gamemode: "adventure",
  difficulty: "peaceful",
  "spawn-protection": 0,
  "max-players": 20,
};

export async function installPaper(dir: string, o: { fetch: Fetch; cacheDir: string; userAgent: string; paper?: PaperBuild }): Promise<void> {
  const paper = o.paper ?? PAPER;
  const cached = await fetchVerified(paper.url, undefined, {
    fetch: o.fetch,
    cacheDir: o.cacheDir,
    userAgent: o.userAgent,
    label: `Paper ${paper.minecraft} build ${paper.build}`,
  });
  if ((await sha256File(cached)) !== paper.sha256) {
    await rm(cached, { force: true });
    throw new UserError(`The Paper ${paper.minecraft} download is damaged (its sha256 doesn't match). Start the lobby again to retry.`);
  }
  await mkdir(dir, { recursive: true });
  await copyFile(cached, join(dir, PAPER_JAR));
}

/** The plugin is built by scripts/install-lobby.sh and baked into the image (MC_LOBBY_BRIDGE_JAR). */
export async function installBridge(dir: string, jar: string | undefined): Promise<void> {
  if (!jar || !existsSync(jar)) {
    throw new UserError(
      "The lobby-bridge plugin is missing. Run scripts/install-lobby.sh again, or point MC_LOBBY_BRIDGE_JAR at lobby-bridge.jar.",
    );
  }
  await mkdir(join(dir, "plugins"), { recursive: true });
  await copyFile(jar, join(dir, "plugins", BRIDGE_JAR));
}

/** Set on every start, even in an existing or restored folder: a host's `transfer` on stop needs it. */
export const FORCED_PROPERTIES: Record<string, string | number | boolean> = { "accepts-transfers": true };

/**
 * A new lobby gets LOBBY_PROPERTIES; an existing one keeps its file and only has FORCED_PROPERTIES
 * set. Returns true when the file was created.
 */
export async function writeLobbyProperties(dir: string): Promise<boolean> {
  const path = join(dir, "server.properties");
  if (!existsSync(path)) {
    await mkdir(dir, { recursive: true });
    await writeFile(path, mergeProperties("", { ...LOBBY_PROPERTIES, ...FORCED_PROPERTIES }));
    return true;
  }
  const existing = await readFile(path, "utf8");
  const merged = mergeProperties(existing, FORCED_PROPERTIES);
  if (merged !== existing) await writeFile(path, merged);
  return false;
}

export const paperCommand = (javaBin: string): string[] => [javaBin, "-Xms512M", "-Xmx1536M", "-jar", PAPER_JAR, "--nogui"];
