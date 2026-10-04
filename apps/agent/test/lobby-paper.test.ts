import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, type Fetch } from "@mc/profile";
import { installBridge, installPaper, PAPER, paperCommand, writeFreshProperties } from "../src/lobby/paper";

let dir: string;
let cacheDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-lobby-paper-"));
  cacheDir = mkdtempSync(join(tmpdir(), "mc-lobby-cache-"));
});
const served = new TextEncoder().encode("paper jar");
const fetch: Fetch = async () => new Response(served);

test("installs Paper after checking its sha256", async () => {
  const paper = { ...PAPER, url: "https://p.test/paper-ok.jar", sha256: await sha256Hex(served) };
  await installPaper(dir, { fetch, cacheDir, userAgent: "test", paper });
  expect(readFileSync(join(dir, "paper.jar"), "utf8")).toBe("paper jar");
});

test("refuses a Paper download whose sha256 doesn't match", async () => {
  const paper = { ...PAPER, url: "https://p.test/paper-bad.jar", sha256: "0".repeat(64) };
  await expect(installPaper(dir, { fetch, cacheDir, userAgent: "test", paper })).rejects.toThrow(
    "The Paper 26.3 download is damaged (its sha256 doesn't match). Start the lobby again to retry.",
  );
  expect(existsSync(join(dir, "paper.jar"))).toBe(false);
});

test("copies the bridge plugin, and says how to fix a missing one", async () => {
  const jar = join(cacheDir, "lobby-bridge.jar");
  writeFileSync(jar, "bridge");
  await installBridge(dir, jar);
  expect(readFileSync(join(dir, "plugins", "lobby-bridge.jar"), "utf8")).toBe("bridge");
  await expect(installBridge(dir, undefined)).rejects.toThrow("The lobby-bridge plugin is missing.");
  await expect(installBridge(dir, join(cacheDir, "nope.jar"))).rejects.toThrow("MC_LOBBY_BRIDGE_JAR");
});

test("a new lobby gets superflat adventure properties once; after that the file is the maintainer's", async () => {
  expect(await writeFreshProperties(dir)).toBe(true);
  const text = readFileSync(join(dir, "server.properties"), "utf8");
  expect(text).toContain("level-type=minecraft:flat");
  expect(text).toContain("gamemode=adventure");
  writeFileSync(join(dir, "server.properties"), "motd=Mine\n");
  expect(await writeFreshProperties(dir)).toBe(false);
  expect(readFileSync(join(dir, "server.properties"), "utf8")).toBe("motd=Mine\n");
});

test("Paper starts without its GUI", () => {
  expect(paperCommand("/jre/bin/java")).toEqual(["/jre/bin/java", "-Xms512M", "-Xmx1536M", "-jar", "paper.jar", "--nogui"]);
});
