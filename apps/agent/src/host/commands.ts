import { createInterface } from "node:readline";
import { USER_AGENT } from "@mc/profile";
import type { Deps } from "../commands";
import { dataDir as defaultDataDir } from "../paths";
import { crashSummary } from "../run/crash";
import { ensureEula } from "../run/eula";
import { requireJava } from "../java/version";
import { buildServer, readMarker } from "../server/build";
import { tailnetAddress } from "./address";
import { createAgentApi, hhmm } from "./api";
import { loadHostConfig, type HostConfig } from "./config";
import { javaCommand, spawnProcess } from "./console";
import type { SessionDeps } from "./deps";
import { hostSession } from "./session";
import { TerminalInput } from "./terminal";
import { downloadTo, uploadFile } from "./transfer";

function onStopSignal(handler: () => void): () => void {
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function sessionDeps(deps: Deps, cfg: HostConfig, input: TerminalInput): SessionDeps {
  const ask = (q: string) => input.ask(q, (text) => process.stdout.write(text));
  return {
    api: createAgentApi({ ...cfg, fetch: deps.fetch }),
    dataDir: deps.dataDir ?? defaultDataDir(),
    log: deps.log,
    ask,
    address: () => tailnetAddress(),
    build: async ({ profile, lock, dir }) => {
      await buildServer({ profile, lock, dir, fetch: deps.fetch, cacheDir: deps.cacheDir, userAgent: USER_AGENT, log: deps.log });
      return readMarker(dir);
    },
    ensureEula: (serverDir) => ensureEula({ configDir: deps.configDir, serverDir, ask, log: deps.log }),
    checkJava: (marker) => requireJava(marker, deps.javaBin),
    launch: (dir, marker) => spawnProcess(javaCommand(marker, deps.javaBin), dir, (text) => process.stdout.write(text)),
    forwardInput: (cb) => input.forwardTo(cb),
    download: (url, dest) => downloadTo(deps.fetch, url, dest),
    upload: (target, file) => uploadFile(deps.fetch, target, file),
    onStopSignal,
    crashSummary,
    now: deps.now ?? Date.now,
    sleep: (ms) => Bun.sleep(ms),
    timers: {
      every: (ms, fn) => {
        const t = setInterval(fn, ms);
        return () => clearInterval(t);
      },
    },
    exit: (code) => process.exit(code),
  };
}

export async function cmdStart(deps: Deps): Promise<void> {
  const cfg = await loadHostConfig(deps.env ?? process.env, deps.configDir);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    await hostSession(sessionDeps(deps, cfg, new TerminalInput(rl)));
  } finally {
    rl.close();
  }
}

export async function cmdStatus(deps: Deps): Promise<void> {
  const cfg = await loadHostConfig(deps.env ?? process.env, deps.configDir);
  const m = await createAgentApi({ ...cfg, fetch: deps.fetch }).manifest();
  deps.log(`World: ${m.world.name} (Minecraft ${m.world.minecraft}), rev ${m.latest?.rev ?? 0}`);
  deps.log(
    m.lease
      ? `${m.lease.you ? "You are" : `${m.lease.name} is`} hosting at ${m.lease.hostAddress}:25565 (since ${hhmm(m.lease.claimedAt)}).`
      : "Nobody is hosting right now, run `mc-host start` to host.",
  );
}

export async function cmdStop(deps: Deps): Promise<void> {
  deps.log(
    "To stop hosting, press Ctrl+C in the window where mc-host start is running. On Linux, the mc-host command from install.sh does this for you.",
  );
}
