import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@mc/profile";
import { runCommand, type Deps } from "../src/commands";
import { manifestFor } from "./host-fakes";

function deps(fetch: Fetch, logs: string[], env: Record<string, string> = { MC_WORKER_URL: "https://w.test", MC_TOKEN: "tok" }): Deps {
  return {
    fetch,
    cacheDir: mkdtempSync(join(tmpdir(), "mc-hc-cache-")),
    configDir: mkdtempSync(join(tmpdir(), "mc-hc-cfg-")),
    dataDir: mkdtempSync(join(tmpdir(), "mc-hc-data-")),
    log: (l) => logs.push(l),
    ask: async () => "",
    env,
  };
}

test("status shows the world and who is hosting", async () => {
  const m = await manifestFor({ latest: { rev: 4, sha256: "a".repeat(64), size: 5 }, lease: { name: "Sam", hostAddress: "100.64.0.9", claimedAt: 0, expiresAt: 0, you: false } });
  const logs: string[] = [];
  await runCommand({ kind: "status" }, deps(async () => new Response(JSON.stringify(m)), logs));
  expect(logs[0]).toBe("World: test (Minecraft 26.3), rev 4");
  expect(logs[1]).toStartWith("Sam is hosting at 100.64.0.9:25565");
});

test("status says how to host when nobody is", async () => {
  const logs: string[] = [];
  await runCommand({ kind: "status" }, deps(async () => new Response(JSON.stringify(await manifestFor())), logs));
  expect(logs[1]).toBe("Nobody is hosting right now, run `mc-host start` to host.");
});

test("stop explains Ctrl+C", async () => {
  const logs: string[] = [];
  await runCommand({ kind: "stop" }, deps(async () => new Response(""), logs));
  expect(logs[0]).toContain("press Ctrl+C in the window where mc-host start is running");
});

test("start without a hosting config fails before touching the terminal", async () => {
  await expect(runCommand({ kind: "start" }, deps(async () => new Response(""), [], {}))).rejects.toThrow("isn't set up to host yet");
});
