import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import { LeaseLostError, OfflineError } from "../src/host/api";
import { bridgeCommand } from "../src/lobby/bridge";
import { lobbyRoot, lobbyServerDir, readLobbyState, writeLobbyState } from "../src/lobby/folder";
import { LOBBY_BACKUP_MS, POLL_MS, runLobby } from "../src/lobby/run";
import { DONE_LINE, until } from "./host-fakes";
import { LOBBY_SESSION, lobbyFixture, makeLobbyHarness } from "./lobby-fakes";

const ALEX = { name: "Alex", address: "100.64.0.3", world: "adventure", minecraft: "26.3" };
const polls = (events: string[]) => events.filter((e) => e.startsWith("api:poll")).length;

async function running(o: Parameters<typeof makeLobbyHarness>[0] = {}) {
  const h = makeLobbyHarness(o);
  const done = runLobby(h.deps);
  done.catch(() => {});
  await until(() => h.servers.length === 1);
  await until(() => polls(h.events) === 1);
  return { h, done, server: h.servers[0]! };
}

test("the plugin command keeps names with spaces in one piece", () => {
  expect(bridgeCommand(null)).toBe("lobbybridge none");
  expect(bridgeCommand({ ...ALEX, name: "Sam  the\tBuilder" })).toBe("lobbybridge host 100.64.0.3 25565 adventure Sam the Builder");
});

test("a first lobby: no backup, tells the plugin once per change, backs up and stops", async () => {
  const { h, done, server } = await running();
  expect(h.events.slice(0, 3)).toEqual(["api:claim fedora", "api:latestBackup", "prepare"]);
  expect(h.logs).toContain("There's no lobby backup yet, so this is a fresh lobby.");
  expect(server.written).toEqual([]);

  server.emit(DONE_LINE);
  expect(server.written).toEqual(["lobbybridge none"]);
  expect(h.logs).toContain("The lobby is up. Players connect to mc-lobby (100.64.0.50:25565).");

  h.api.host = ALEX;
  h.timers.fire(POLL_MS);
  await until(() => server.written.length === 2);
  expect(server.written[1]).toBe("lobbybridge host 100.64.0.3 25565 adventure Alex");
  h.timers.fire(POLL_MS);
  await until(() => polls(h.events) === 3);
  expect(server.written).toHaveLength(2);

  h.timers.fire(LOBBY_BACKUP_MS);
  await until(() => h.events.includes("api:commitBackup 1"));
  expect(server.written.slice(2)).toEqual(["save-off", "save-all flush", "save-on"]);

  h.stop.fire();
  await done;
  expect(server.written.at(-1)).toBe("stop");
  expect(h.events).toContain("api:commitBackup 2");
  expect(h.events.at(-1)).toBe(`api:release ${LOBBY_SESSION}-1`);
  expect(await readLobbyState(h.deps.dataDir)).toEqual({ sessionId: `${LOBBY_SESSION}-1`, backupRev: 2 });
  expect(h.logs.at(-1)).toBe("The lobby has stopped.");
});

test("a new machine restores the latest backup", async () => {
  const fx = await lobbyFixture();
  const h0 = makeLobbyHarness({ fixtureZip: fx.zip });
  h0.api.latest = { rev: 4, sha256: fx.sha256, size: fx.size, url: "https://r2.test/lobby4.zip" };
  const done = runLobby(h0.deps);
  await until(() => h0.servers.length === 1);
  expect(readFileSync(join(lobbyServerDir(h0.deps.dataDir), "world", "level.dat"), "utf8")).toBe("from the backup");
  expect(await readLobbyState(h0.deps.dataDir)).toMatchObject({ backupRev: 4 });
  h0.stop.fire();
  await done;
  expect(h0.events).toContain("api:commitBackup 5");
});

test("a machine whose lobby is older than the backup moves it aside and restores", async () => {
  const fx = await lobbyFixture();
  const h = makeLobbyHarness({ fixtureZip: fx.zip });
  const dir = lobbyServerDir(h.deps.dataDir);
  mkdirSync(join(dir, "world"), { recursive: true });
  writeFileSync(join(dir, "server.properties"), "motd=Old\n");
  writeFileSync(join(dir, "world", "level.dat"), "stale");
  await writeLobbyState(h.deps.dataDir, { backupRev: 2 });
  h.api.latest = { rev: 4, sha256: fx.sha256, size: fx.size, url: "https://r2.test/lobby4.zip" };
  const done = runLobby(h.deps);
  await until(() => h.servers.length === 1);
  expect(readFileSync(join(dir, "world", "level.dat"), "utf8")).toBe("from the backup");
  expect(h.logs.some((l) => l.startsWith("The lobby on this machine is older than the backup (rev 2, the backup is rev 4)"))).toBe(true);
  expect(readdirSync(lobbyRoot(h.deps.dataDir)).filter((n) => n.startsWith("old-"))).toHaveLength(1);
  h.stop.fire();
  await done;
});

test("a machine whose lobby matches the latest backup keeps it", async () => {
  const h = makeLobbyHarness();
  const dir = lobbyServerDir(h.deps.dataDir);
  mkdirSync(join(dir, "world"), { recursive: true });
  writeFileSync(join(dir, "server.properties"), "motd=Mine\n");
  writeFileSync(join(dir, "world", "level.dat"), "mine");
  await writeLobbyState(h.deps.dataDir, { backupRev: 4 });
  h.api.latest = { rev: 4, sha256: "a".repeat(64), size: 10, url: "https://r2.test/lobby4.zip" };
  const done = runLobby(h.deps);
  await until(() => h.servers.length === 1);
  expect(h.events.some((e) => e.startsWith("download"))).toBe(false);
  expect(readFileSync(join(dir, "world", "level.dat"), "utf8")).toBe("mine");
  h.stop.fire();
  await done;
});

test("a damaged backup stops the start, releases the slot and points at --fresh", async () => {
  const fx = await lobbyFixture();
  const h = makeLobbyHarness({ fixtureZip: fx.zip });
  h.api.latest = { rev: 3, sha256: "0".repeat(64), size: fx.size, url: "https://r2.test/lobby3.zip" };
  await expect(runLobby(h.deps)).rejects.toThrow(
    "Couldn't restore lobby backup rev 3: The downloaded lobby backup is damaged (its sha256 doesn't match). Run `mc-host lobby --fresh` to start an empty lobby instead.",
  );
  expect(h.events.filter((e) => e.startsWith("download"))).toHaveLength(3);
  expect(h.events.at(-1)).toBe(`api:release ${LOBBY_SESSION}-1`);
  expect(h.servers).toHaveLength(0);
  expect(h.stop.count).toBe(0);
});

test("--fresh ignores the backups and carries on numbering after them", async () => {
  const h = makeLobbyHarness({ fresh: true });
  h.api.latest = { rev: 3, sha256: "0".repeat(64), size: 10, url: "https://r2.test/lobby3.zip" };
  const done = runLobby(h.deps);
  await until(() => h.servers.length === 1);
  expect(h.events.some((e) => e.startsWith("download"))).toBe(false);
  expect(h.logs).toContain("Starting a fresh lobby.");
  h.stop.fire();
  await done;
  expect(h.events).toContain("api:commitBackup 4");
});

test("a restart on the same machine asks for its previous session", async () => {
  const h = makeLobbyHarness();
  await writeLobbyState(h.deps.dataDir, { sessionId: "lobby-session-old-0001", backupRev: 0 });
  const done = runLobby(h.deps);
  await until(() => h.servers.length === 1);
  expect(h.api.claims[0]).toEqual({ address: "100.64.0.50", machine: "fedora", previousSessionId: "lobby-session-old-0001" });
  h.stop.fire();
  await done;
});

test("a lapsed session is claimed back; if another lobby took over, this one stops without a backup", async () => {
  const { h, done, server } = await running();
  server.emit(DONE_LINE);
  h.api.pollErrors.push(new LeaseLostError("lapsed"));
  h.timers.fire(POLL_MS);
  await until(() => h.logs.includes("The lobby's slot had lapsed; it's back."));
  expect(h.api.claims[1]!.previousSessionId).toBe(`${LOBBY_SESSION}-1`);

  const refused = "The lobby is already running on pi (heard from it just now). Stop it there first, or run `mc-host admin lobby release`.";
  h.api.pollErrors.push(new LeaseLostError("lapsed"));
  h.api.claimErrors.push(new UserError(refused));
  h.timers.fire(POLL_MS);
  await expect(done).rejects.toThrow(refused);
  expect(server.written.at(-1)).toBe("stop");
  expect(h.events.some((e) => e.startsWith("api:commitBackup"))).toBe(false);
  expect(h.events.some((e) => e.startsWith("api:release"))).toBe(false);
});

test("an unreachable Worker is logged once, and the lobby keeps running", async () => {
  const { h, done } = await running();
  h.api.pollErrors.push(new OfflineError("no network"), new OfflineError("no network"));
  h.timers.fire(POLL_MS);
  await until(() => polls(h.events) === 2);
  h.timers.fire(POLL_MS);
  await until(() => polls(h.events) === 3);
  expect(h.logs.filter((l) => l.startsWith("Can't reach the Worker"))).toEqual([
    "Can't reach the Worker (no network). The lobby keeps running and tries again.",
  ]);
  h.timers.fire(POLL_MS);
  await until(() => h.logs.includes("Reached the Worker again."));
  h.stop.fire();
  await done;
});

test("a Paper crash releases the slot and says Docker restarts it", async () => {
  const { h, done, server } = await running();
  server.exit(1);
  await expect(done).rejects.toThrow("Paper stopped with exit code 1.");
  expect(h.logs).toContain("Last 30 lines of logs/latest.log:\nboom");
  expect(h.events.at(-1)).toBe(`api:release ${LOBBY_SESSION}-1`);
  expect(h.events.some((e) => e.startsWith("api:commitBackup"))).toBe(false);
});
