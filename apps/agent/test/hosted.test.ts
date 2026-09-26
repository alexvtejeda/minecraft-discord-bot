import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LeaseLostError } from "../src/host/api";
import { AUTOSAVE_MS, HEARTBEAT_MS } from "../src/host/deps";
import type { Prepared } from "../src/host/prepare";
import { runHosted } from "../src/host/run";
import { readState, serverDirFor } from "../src/host/state";
import { CHUNKY_DONE_LINE, DONE_LINE, makeHarness, manifestFor, MARKER, SESSION, until, type FakeServer } from "./host-fakes";

async function started(o: { rev?: number; pregenDone?: boolean; respond?: (line: string, s: FakeServer) => void } = {}) {
  const rev = o.rev ?? 0;
  const h = makeHarness(await manifestFor({ pregenDone: o.pregenDone }), { respond: o.respond });
  h.api.latestRev = rev;
  const serverDir = serverDirFor(h.deps.dataDir, "w1");
  mkdirSync(join(serverDir, "world"), { recursive: true });
  writeFileSync(join(serverDir, "world", "level.dat"), "live");
  let unhooked = false;
  let prepHeartbeatStopped = false;
  const p: Prepared = {
    world: { id: "w1", name: "test", minecraft: "26.3" },
    sessionId: SESSION,
    baseRev: rev,
    serverDir,
    levelName: "world",
    marker: MARKER,
    pregenDone: o.pregenDone ?? false,
    address: "100.64.0.3",
    javaBin: "/jre/bin/java",
    unhook: () => void (unhooked = true),
    stopHeartbeat: () => void (prepHeartbeatStopped = true),
  };
  const done = runHosted(h.deps, p);
  done.catch(() => {});
  await until(() => h.servers.length === 1);
  return { h, p, done, server: h.servers[0]!, unhooked: () => unhooked, prepHeartbeatStopped: () => prepHeartbeatStopped };
}
const idx = (events: string[], e: string) => events.indexOf(e);

test("a full session: Done, pre-generation, heartbeat, autosave, then a clean stop", async () => {
  const { h, p, done, server, unhooked } = await started();
  expect(unhooked()).toBe(true);
  expect(h.launches).toEqual([{ dir: p.serverDir, javaBin: "/jre/bin/java" }]);
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 0, dirty: true });

  server.emit(DONE_LINE);
  expect(h.logs).toContain("Hosting test. Players connect to 100.64.0.3:25565");
  expect(server.written).toEqual(["chunky radius 2000", "chunky start"]);

  h.timers.fire(HEARTBEAT_MS);
  await until(() => h.events.includes("api:heartbeat"));

  h.timers.fire(AUTOSAVE_MS);
  await until(() => h.events.includes("api:commit 1"));
  expect(idx(h.events, "server:save-off")).toBeLessThan(idx(h.events, "server:save-all flush"));
  expect(idx(h.events, "server:save-on")).toBeLessThan(idx(h.events, "api:uploadUrl 0"));
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 1, dirty: true });

  server.emit(CHUNKY_DONE_LINE);
  h.stop.fire();
  await done;
  expect(server.written.at(-1)).toBe("stop");
  expect(h.events).toContain("api:commit 2 pregen");
  expect(h.events.at(-1)).toBe("api:release");
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 2, dirty: false });
  expect(h.logs).toContain("World saved as rev 2. Hosting has stopped.");
  expect(h.stop.count).toBe(0);
  expect(h.forwarded.cb).toBeNull();
});

test("pre-generation continues on a later rev and is skipped once done", async () => {
  const later = await started({ rev: 2 });
  later.server.emit(DONE_LINE);
  expect(later.server.written).toEqual(["chunky continue"]);
  const finished = await started({ rev: 2, pregenDone: true });
  finished.server.emit(DONE_LINE);
  expect(finished.server.written).toEqual([]);
});

test("typed lines go to the server; a second Ctrl+C just says it's still stopping", async () => {
  const { h, server, done } = await started({ respond: () => {} });
  h.forwarded.cb!("say hi");
  expect(server.written).toEqual(["say hi"]);
  h.stop.fire();
  h.stop.fire();
  expect(h.logs).toContain("Still stopping, please wait…");
  server.exit(0);
  await done;
});

test("a lost lease (for example the same person hosting on a second PC) stops without uploading", async () => {
  const { h, done, server } = await started();
  h.api.heartbeatError = new LeaseLostError("This hosting session is no longer valid.");
  h.timers.fire(HEARTBEAT_MS);
  const err = await done.catch((e) => e);
  expect(server.written.some((l) => l.startsWith("say [mc-host] Someone else took over hosting"))).toBe(true);
  expect(server.written.at(-1)).toBe("stop");
  expect(err.message).toStartWith("This hosting session is no longer valid. Your copy of the world was moved to ");
  expect(h.events.some((e) => e.startsWith("api:uploadUrl"))).toBe(false);
  expect(readdirSync(join(h.deps.dataDir, "recovered"))).toHaveLength(1);
  expect((await readState(h.deps.dataDir))?.dirty).toBe(false);
});

test("a failed final upload keeps the lease and the dirty flag", async () => {
  const { h, done } = await started();
  h.api.uploadFailures = 3;
  h.stop.fire();
  const err = await done.catch((e) => e);
  expect(err.message).toBe(
    "Couldn't upload the world. Run `mc-host start` again when you're back online. Your progress is saved on this PC.",
  );
  expect(h.events).not.toContain("api:release");
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 0, dirty: true });
});

test("a crash while booting (before Done) defaults to keeping the last autosave", async () => {
  const { h, done, server } = await started();
  server.exit(1);
  const err = await done.catch((e) => e);
  expect(h.logs.join("\n")).toContain("Last 30 lines of logs/latest.log");
  expect(h.events).toContain("ask:The server crashed. Upload the world as it is? [y/N] ");
  expect(h.events.some((e) => e.startsWith("api:uploadUrl"))).toBe(false);
  expect(server.written).toEqual([]);
  expect(h.events).toContain("api:release");
  expect(err.message).toStartWith("The server crashed (exit code 1). A copy of the world is in ");
  expect(existsSync(join(h.deps.dataDir, "recovered"))).toBe(true);
  expect((await readState(h.deps.dataDir))?.dirty).toBe(false);
});

test("after a crash, answering y uploads the world as it is", async () => {
  const { h, done, server } = await started();
  h.answers.push("y");
  server.exit(1);
  await done.catch(() => {});
  expect(h.events).toContain("api:commit 1");
  expect(h.events.at(-1)).toBe("api:release");
});

test("Ctrl+C during an autosave upload waits for it, then uploads the next rev", async () => {
  const { h, done } = await started();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  h.deps.upload = async (target) => {
    h.events.push(`upload ${target.url}`);
    if (!h.events.includes("gate-passed")) {
      h.events.push("gate-passed");
      await gate;
    }
  };
  h.timers.fire(AUTOSAVE_MS);
  await until(() => h.events.includes("gate-passed"));
  h.stop.fire();
  await Bun.sleep(20);
  open();
  await done;
  const order = h.events.filter((e) => e.startsWith("api:uploadUrl") || e.startsWith("api:commit"));
  expect(order).toEqual(["api:uploadUrl 0", "api:commit 1", "api:uploadUrl 1", "api:commit 2"]);
});

test("a commit whose reply was lost is retried on its own, not uploaded again", async () => {
  const { h, done } = await started();
  h.api.commitFailures = 1;
  h.stop.fire();
  await done;
  const order = h.events.filter((e) => e.startsWith("api:uploadUrl") || e.startsWith("api:commit"));
  expect(order).toEqual(["api:uploadUrl 0", "api:commit 1", "api:commit 1"]);
  expect(h.events.at(-1)).toBe("api:release");
});

test("the run phase takes over the heartbeat and keeps it going through the final upload", async () => {
  const { h, done, prepHeartbeatStopped } = await started();
  expect(prepHeartbeatStopped()).toBe(true);
  h.deps.upload = async () => {
    h.timers.fire(HEARTBEAT_MS);
  };
  h.stop.fire();
  await done;
  expect(h.events.indexOf("api:heartbeat")).toBeGreaterThan(h.events.indexOf("server:stop"));
});
