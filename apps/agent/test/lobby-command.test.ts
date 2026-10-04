import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/commands";
import { cmdLobby } from "../src/lobby/command";

const deps = (env: Record<string, string>): Deps => ({
  fetch: async () => new Response("unused", { status: 500 }),
  cacheDir: mkdtempSync(join(tmpdir(), "mc-lobby-cmd-")),
  configDir: mkdtempSync(join(tmpdir(), "mc-lobby-cfg-")),
  log: () => {},
  ask: async () => "",
  env,
});

test("the lobby needs the EULA agreed through MC_ACCEPT_EULA", async () => {
  await expect(cmdLobby({ fresh: false }, deps({ MC_WORKER_URL: "https://w.test", MC_TOKEN: "t" }))).rejects.toThrow(
    "Running the lobby means agreeing to Mojang's EULA (https://aka.ms/MinecraftEULA). Set MC_ACCEPT_EULA=true once you have; scripts/install-lobby.sh asks you.",
  );
});

test("the lobby needs a Worker URL and a token", async () => {
  await expect(cmdLobby({ fresh: false }, deps({ MC_ACCEPT_EULA: "true" }))).rejects.toThrow("isn't set up to host yet");
});
