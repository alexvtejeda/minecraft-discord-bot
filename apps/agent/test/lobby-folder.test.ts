import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChecksumError } from "../src/host/snapshot";
import { lobbyRoot, lobbyServerDir, moveLobbyAside, readLobbyState, restoreLobby, writeLobbyState, zipLobby } from "../src/lobby/folder";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-lobby-folder-"));
});

function put(dir: string, rel: string, data: string) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), data);
}

function listAll(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listAll(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}

function lobbyFolder(dir: string) {
  put(dir, "world/level.dat", "level");
  put(dir, "world/session.lock", "locked");
  put(dir, "plugins/WorldEdit.jar", "worldedit");
  put(dir, "plugins/WorldEdit/config.yml", "wand: wooden_axe");
  put(dir, "plugins/.paper-remapped/WorldEdit.jar", "remapped");
  put(dir, "plugins/lobby-bridge.jar", "bridge");
  put(dir, "server.properties", "motd=Lobby");
  put(dir, "cache/mojang_26.3.jar", "vanilla");
  put(dir, "libraries/com/x.jar", "lib");
  put(dir, "versions/26.3/paper.jar", "patched");
  put(dir, "logs/latest.log", "log");
  put(dir, "paper.jar", "paper");
}

test("a backup leaves out what Paper downloads again, and restores into a clean folder", async () => {
  const src = join(root, "src");
  lobbyFolder(src);
  const zip = join(root, "backup.zip");
  const z = await zipLobby(src, zip);
  const dest = join(root, "restored");
  put(dest, "stale.txt", "from before");
  await restoreLobby(zip, dest, z.sha256);
  expect(listAll(dest)).toEqual(["plugins/WorldEdit.jar", "plugins/WorldEdit/config.yml", "server.properties", "world/level.dat"]);
});

test("a damaged backup is refused before anything is touched", async () => {
  const src = join(root, "src");
  lobbyFolder(src);
  const zip = join(root, "backup.zip");
  await zipLobby(src, zip);
  const dest = join(root, "restored");
  put(dest, "stale.txt", "from before");
  await expect(restoreLobby(zip, dest, "0".repeat(64))).rejects.toBeInstanceOf(ChecksumError);
  await expect(restoreLobby(zip, dest, "0".repeat(64))).rejects.toThrow("The downloaded lobby backup is damaged");
  expect(readFileSync(join(dest, "stale.txt"), "utf8")).toBe("from before");
});

test("lobby state starts at rev 0 and round-trips", async () => {
  expect(await readLobbyState(root)).toEqual({ backupRev: 0 });
  await writeLobbyState(root, { sessionId: "lobby-session-0123456789", backupRev: 4 });
  expect(await readLobbyState(root)).toEqual({ sessionId: "lobby-session-0123456789", backupRev: 4 });
});

test("moving the lobby aside keeps it under lobby/old-<stamp>", async () => {
  expect(await moveLobbyAside(root, 0)).toBeNull();
  put(lobbyServerDir(root), "server.properties", "motd=Old");
  const dest = await moveLobbyAside(root, new Date(2026, 9, 3, 21, 5, 9).getTime());
  expect(dest).toBe(join(lobbyRoot(root), "old-2026-10-03_21-05-09"));
  expect(readFileSync(join(dest!, "server.properties"), "utf8")).toBe("motd=Old");
  expect(existsSync(lobbyServerDir(root))).toBe(false);
});
