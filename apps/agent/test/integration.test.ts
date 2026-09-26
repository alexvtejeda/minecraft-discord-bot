import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { createAdminApi, createAgentApi, LeaseHeldError } from "../src/host/api";
import { AUTOSAVE_MS } from "../src/host/deps";
import { hostSession } from "../src/host/session";
import { serverDirFor } from "../src/host/state";
import { downloadTo, uploadFile } from "../src/host/transfer";
import { DONE_LINE, FakeServer, makeHarness, manifestFor, until, worldFiles } from "./host-fakes";

const RUN = process.env.INTEGRATION === "1";
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER_DIR = join(import.meta.dir, "..", "..", "worker");
let wrangler: Subprocess | undefined;

beforeAll(async () => {
  if (!RUN) return;
  const persist = mkdtempSync(join(tmpdir(), "mc-wrangler-"));
  const env = { ...process.env, CI: "1" };
  const migrate = Bun.spawnSync(["bunx", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: WORKER_DIR,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (migrate.exitCode !== 0) throw new Error("Applying the D1 migrations locally failed");
  wrangler = Bun.spawn(
    [
      "bunx", "wrangler", "dev", "--port", String(PORT), "--persist-to", persist,
      "--var", "ADMIN_SECRET:itest", "--var", "DEV_R2_PROXY:1",
      "--var", "R2_ACCESS_KEY_ID:unused", "--var", "R2_SECRET_ACCESS_KEY:unused",
    ],
    { cwd: WORKER_DIR, env, stdout: "ignore", stderr: "inherit" },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("wrangler dev didn't start within 60 seconds");
}, 90_000);

afterAll(() => {
  wrangler?.kill();
});

/** A hosting session with the real client and transfers; the server process is fake. */
async function host(token: string, writeWorld: string | null) {
  const h = makeHarness(await manifestFor());
  h.deps.api = createAgentApi({ workerUrl: BASE, token, fetch });
  h.deps.download = (url, dest) => downloadTo(fetch, url, dest);
  h.deps.upload = (target, file) => uploadFile(fetch, target, file);
  h.deps.launch = (dir) => {
    if (writeWorld !== null) {
      mkdirSync(join(dir, "world"), { recursive: true });
      writeFileSync(join(dir, "world", "level.dat"), writeWorld);
    }
    const s = new FakeServer(undefined, h.events);
    h.servers.push(s);
    return s;
  };
  return h;
}

test.skipIf(!RUN)("two hosts hand the world over through the real Worker", async () => {
  const admin = createAdminApi({ workerUrl: BASE, secret: "itest", fetch });
  const alex = await admin.mintToken({ discordId: "100000000000000001", name: "Alex" });
  const sam = await admin.mintToken({ discordId: "100000000000000002", name: "Sam" });
  const { profile, lockfile } = await worldFiles();
  const world = await admin.createWorld({ name: `itest-${Date.now()}`, profile, lockfile, replace: true });

  // Alex hosts, autosaves once, and Sam can't claim meanwhile.
  const a = await host(alex, "written by Alex");
  const runA = hostSession(a.deps);
  await until(() => a.servers.length === 1);
  a.servers[0]!.emit(DONE_LINE);
  a.timers.fire(AUTOSAVE_MS);
  await until(() => a.logs.includes("Autosaved as rev 1."), 15_000);
  await expect(createAgentApi({ workerUrl: BASE, token: sam, fetch }).claim("100.64.0.9")).rejects.toBeInstanceOf(LeaseHeldError);
  a.stop.fire();
  await runA;
  expect(a.logs).toContain("World saved as rev 2. Hosting has stopped.");

  // Sam hosts next and gets Alex's world.
  const b = await host(sam, null);
  const runB = hostSession(b.deps);
  await until(() => b.servers.length === 1, 15_000);
  expect(readFileSync(join(serverDirFor(b.deps.dataDir, world.id), "world", "level.dat"), "utf8")).toBe("written by Alex");
  b.stop.fire();
  await runB;

  const status = await admin.status();
  expect(status.world).toMatchObject({ id: world.id, latestRev: 3 });
  expect(status.lease).toBeNull();
}, 60_000);
