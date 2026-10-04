import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { USER_AGENT, UserError } from "@mc/profile";
import type { Deps } from "../commands";
import { tailnetAddress } from "../host/address";
import { createLobbyApi } from "../host/api";
import { loadHostConfig } from "../host/config";
import { spawnProcess } from "../host/console";
import { realTimers } from "../host/deps";
import { onStopSignal } from "../host/signals";
import { TerminalInput } from "../host/terminal";
import { downloadTo, uploadFile } from "../host/transfer";
import { javaFor } from "../java/runtime";
import { dataDir as defaultDataDir } from "../paths";
import { crashSummary } from "../run/crash";
import { EULA_URL } from "../run/eula";
import { installBridge, installPaper, PAPER, paperCommand, writeLobbyProperties } from "./paper";
import { runLobby } from "./run";

export async function cmdLobby(cmd: { fresh: boolean }, deps: Deps): Promise<void> {
  const env = deps.env ?? process.env;
  const cfg = await loadHostConfig(env, deps.configDir);
  // The lobby runs unattended in Docker, so the EULA is agreed once by install-lobby.sh.
  if (env.MC_ACCEPT_EULA !== "true") {
    throw new UserError(
      `Running the lobby means agreeing to Mojang's EULA (${EULA_URL}). Set MC_ACCEPT_EULA=true once you have; scripts/install-lobby.sh asks you.`,
    );
  }
  const rl = createInterface({ input: process.stdin, terminal: false });
  const input = new TerminalInput(rl);
  const download = { fetch: deps.fetch, cacheDir: deps.cacheDir, userAgent: USER_AGENT };
  try {
    await runLobby({
      api: createLobbyApi({ ...cfg, fetch: deps.fetch }),
      dataDir: deps.dataDir ?? defaultDataDir(),
      log: deps.log,
      address: () => tailnetAddress(),
      machine: env.MC_LOBBY_MACHINE || hostname(),
      fresh: cmd.fresh,
      prepareServer: async (dir) => {
        await mkdir(dir, { recursive: true });
        await installPaper(dir, download);
        await installBridge(dir, env.MC_LOBBY_BRIDGE_JAR);
        await writeLobbyProperties(dir);
        await writeFile(join(dir, "eula.txt"), "eula=true\n");
      },
      ensureJava: () => javaFor(PAPER, { ...download, log: deps.log, override: deps.javaBin }),
      launch: (dir, javaBin) => spawnProcess(paperCommand(javaBin), dir, (text) => process.stdout.write(text)),
      forwardInput: (cb) => input.forwardTo(cb),
      download: (url, dest) => downloadTo(deps.fetch, url, dest),
      upload: (target, file) => uploadFile(deps.fetch, target, file),
      onStopSignal,
      crashSummary,
      now: deps.now ?? Date.now,
      sleep: (ms) => Bun.sleep(ms),
      timers: realTimers,
      // process.exit never returns; runLobby's early-cancel path relies on that, since an in-flight restore isn't aborted.
      exit: (code) => process.exit(code),
    });
  } finally {
    rl.close();
  }
}
