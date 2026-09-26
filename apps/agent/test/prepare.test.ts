import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { LeaseHeldError } from "../src/host/api";
import { HEARTBEAT_MS } from "../src/host/deps";
import { prepare } from "../src/host/prepare";
import { readState, serverDirFor, writeState } from "../src/host/state";
import { fixtureSnapshot, makeHarness, manifestFor, MARKER, until, type Harness } from "./host-fakes";

/** Leave this PC as if its last session never finished uploading. */
async function dirtyPc(h: Harness, baseRev: number, o: { worldId?: string; levelName?: string } = {}) {
  const worldId = o.worldId ?? "w1";
  const levelName = o.levelName ?? "world";
  const dir = serverDirFor(h.deps.dataDir, worldId);
  mkdirSync(join(dir, levelName), { recursive: true });
  writeFileSync(join(dir, levelName, "level.dat"), "local progress");
  const t = new Date(2026, 8, 26, 14, 32);
  utimesSync(join(dir, levelName, "level.dat"), t, t);
  await writeState(h.deps.dataDir, { worldId, baseRev, dirty: true });
}
const recovered = (h: Harness) => (existsSync(join(h.deps.dataDir, "recovered")) ? readdirSync(join(h.deps.dataDir, "recovered")) : []);
const asked = (h: Harness) => h.events.filter((e) => e.startsWith("ask:"));

test("a fresh world: claim, build without datapacks, no download", async () => {
  const h = makeHarness(await manifestFor({ profile: { datapacks: ["vt:afk-display"] } }));
  const p = await prepare(h.deps);
  expect(p).toMatchObject({ baseRev: 0, sessionId: "session-0123456789", levelName: "world", address: "100.64.0.3", marker: MARKER });
  expect(h.events).toEqual(["api:manifest", "api:claim 100.64.0.3", "build"]);
  expect(h.builds[0]!.profile.datapacks).toEqual([]);
  expect(h.logs.join("\n")).toContain("datapacks and the resource pack aren't supported yet");
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 0, dirty: false });
  expect(h.stop.count).toBe(1);
  p.unhook();
  expect(h.stop.count).toBe(0);
});

test("downloads and unpacks the latest rev when this PC is behind", async () => {
  const fx = await fixtureSnapshot();
  const h = makeHarness(await manifestFor({ latest: { rev: 3, sha256: fx.sha256, size: fx.size } }), { fixtureZip: fx.zip });
  const p = await prepare(h.deps);
  expect(p.baseRev).toBe(3);
  expect(h.events).toContain("download https://r2.test/rev3.zip");
  expect(readFileSync(join(p.serverDir, "world", "level.dat"), "utf8")).toBe("from the cloud");
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 3, dirty: false });
});

test("skips the download when this PC already has that rev", async () => {
  const h = makeHarness(await manifestFor({ latest: { rev: 3, sha256: "a".repeat(64), size: 5 } }));
  mkdirSync(join(serverDirFor(h.deps.dataDir, "w1"), "world"), { recursive: true });
  await writeState(h.deps.dataDir, { worldId: "w1", baseRev: 3, dirty: false });
  await prepare(h.deps);
  expect(h.events.some((e) => e.startsWith("download"))).toBe(false);
});

test("retries a damaged download three times, then gives up and releases", async () => {
  const fx = await fixtureSnapshot();
  const h = makeHarness(await manifestFor({ latest: { rev: 2, sha256: "0".repeat(64), size: fx.size } }), { fixtureZip: fx.zip });
  await expect(prepare(h.deps)).rejects.toThrow("Couldn't download the world. Try again later.");
  expect(h.events.filter((e) => e.startsWith("download"))).toHaveLength(3);
  expect(h.logs.filter((l) => l === "The downloaded world is damaged. Trying again…")).toHaveLength(2);
  expect(h.events).toContain("api:release");
});

test("recovery: nobody hosted since, so it asks, then uploads as the next rev", async () => {
  const h = makeHarness(await manifestFor({ latest: { rev: 2, sha256: "a".repeat(64), size: 5 } }));
  await dirtyPc(h, 2);
  h.answers.push("");
  const p = await prepare(h.deps);
  expect(asked(h)).toEqual(["ask:Your last session didn't finish uploading (last save 14:32). Upload it now? [Y/n] "]);
  expect(p.baseRev).toBe(3);
  expect(h.events).toContain("api:commit 3");
  expect(h.events.some((e) => e.startsWith("download"))).toBe(false);
  expect(await readState(h.deps.dataDir)).toEqual({ worldId: "w1", baseRev: 3, dirty: false });
});

test("recovery: answering no sets the copy aside and downloads instead", async () => {
  const fx = await fixtureSnapshot();
  const h = makeHarness(await manifestFor({ latest: { rev: 2, sha256: fx.sha256, size: fx.size } }), { fixtureZip: fx.zip });
  await dirtyPc(h, 2);
  h.answers.push("n");
  const p = await prepare(h.deps);
  expect(recovered(h)).toHaveLength(1);
  expect(readFileSync(join(h.deps.dataDir, "recovered", recovered(h)[0]!, "world", "level.dat"), "utf8")).toBe("local progress");
  expect(readFileSync(join(p.serverDir, "world", "level.dat"), "utf8")).toBe("from the cloud");
});

test("recovery: someone hosted since, so the copy is set aside without asking", async () => {
  const fx = await fixtureSnapshot();
  const h = makeHarness(await manifestFor({ latest: { rev: 4, sha256: fx.sha256, size: fx.size } }), { fixtureZip: fx.zip });
  await dirtyPc(h, 2);
  await prepare(h.deps);
  expect(asked(h)).toEqual([]);
  expect(recovered(h)).toHaveLength(1);
  expect(h.logs.join("\n")).toContain("someone has hosted since");
});

test("recovery: someone else is hosting, so the copy is set aside and the claim is refused", async () => {
  const holder = { name: "Sam", hostAddress: "100.64.0.9", claimedAt: 0, expiresAt: 0 };
  const h = makeHarness(await manifestFor({ latest: { rev: 2, sha256: "a".repeat(64), size: 5 }, lease: { ...holder, you: false } }));
  await dirtyPc(h, 2);
  h.api.claimError = new LeaseHeldError("Sam is already hosting at 100.64.0.9 (since 01:00).", holder);
  await expect(prepare(h.deps)).rejects.toBeInstanceOf(LeaseHeldError);
  expect(asked(h)).toEqual([]);
  expect(recovered(h)).toHaveLength(1);
});

test("recovery: a world that's no longer active is set aside", async () => {
  const h = makeHarness(await manifestFor());
  await dirtyPc(h, 5, { worldId: "old" });
  await prepare(h.deps);
  expect(recovered(h)[0]).toEndWith("-old");
});

test("recovery reads the last save time from a custom level-name folder", async () => {
  const h = makeHarness(await manifestFor({ latest: { rev: 1, sha256: "a".repeat(64), size: 5 }, profile: { properties: { "level-name": "adventure" } } }));
  await dirtyPc(h, 1, { levelName: "adventure" });
  h.answers.push("y");
  const p = await prepare(h.deps);
  expect(asked(h)[0]).toContain("(last save 14:32)");
  expect(p.levelName).toBe("adventure");
});

test("a failure after the claim releases the lease", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.build = async () => {
    throw new UserError("Couldn't download lithium.jar");
  };
  await expect(prepare(h.deps)).rejects.toThrow("lithium.jar");
  expect(h.events).toContain("api:release");
  expect(h.stop.count).toBe(0);
});

test("Ctrl+C while preparing releases the lease and exits with 130", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.build = async () => {
    h.stop.fire();
    await Bun.sleep(5);
    return MARKER;
  };
  await prepare(h.deps);
  expect(h.events).toContain("api:release");
  expect(h.exits).toEqual([130]);
});

test("declining the EULA stops before claiming", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.ensureEula = async () => false;
  await expect(prepare(h.deps)).rejects.toThrow("agree to the EULA");
  expect(h.events.some((e) => e.startsWith("api:claim"))).toBe(false);
});

test("heartbeats from the claim on, until the run phase stops it", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.build = async () => {
    h.timers.fire(HEARTBEAT_MS);
    return MARKER;
  };
  const p = await prepare(h.deps);
  await until(() => h.events.includes("api:heartbeat"));
  p.stopHeartbeat();
  h.timers.fire(HEARTBEAT_MS);
  expect(h.events.filter((e) => e === "api:heartbeat")).toHaveLength(1);
});

test("a failure after the claim stops the heartbeat too", async () => {
  const h = makeHarness(await manifestFor());
  h.deps.build = async () => {
    throw new UserError("Couldn't download lithium.jar");
  };
  await expect(prepare(h.deps)).rejects.toThrow("lithium.jar");
  h.timers.fire(HEARTBEAT_MS);
  expect(h.events).not.toContain("api:heartbeat");
});
