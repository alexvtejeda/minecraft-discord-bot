import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LobbyClaimRequest, LobbyClaimResponse, LobbyCommitRequest, LobbyHost, LobbyPollResponse, SnapshotRef, UploadTarget } from "@mc/protocol";
import type { LobbyApi } from "../src/host/api";
import { zipLobby } from "../src/lobby/folder";
import type { LobbyDeps } from "../src/lobby/run";
import { FakeServer, ManualTimers, StopSignal } from "./host-fakes";

export const LOBBY_SESSION = "lobby-session-0123456789";

export class FakeLobbyApi implements LobbyApi {
  latest: SnapshotRef | null = null;
  host: LobbyHost | null = null;
  claims: LobbyClaimRequest[] = [];
  /** Each call takes the next error, if any. */
  claimErrors: Error[] = [];
  pollErrors: Error[] = [];
  commits: LobbyCommitRequest[] = [];
  private sessions = 0;

  constructor(private events: string[]) {}

  async claim(req: LobbyClaimRequest): Promise<LobbyClaimResponse> {
    this.events.push(`api:claim ${req.machine}`);
    this.claims.push(req);
    const err = this.claimErrors.shift();
    if (err) throw err;
    this.sessions++;
    return { sessionId: `${LOBBY_SESSION}-${this.sessions}`, expiresAt: 0 };
  }
  async poll(sessionId: string): Promise<LobbyPollResponse> {
    this.events.push(`api:poll ${sessionId}`);
    const err = this.pollErrors.shift();
    if (err) throw err;
    return { host: this.host, expiresAt: 0 };
  }
  async release(sessionId: string): Promise<void> {
    this.events.push(`api:release ${sessionId}`);
  }
  async backupUrl(): Promise<UploadTarget> {
    const rev = (this.latest?.rev ?? 0) + 1;
    this.events.push("api:backupUrl");
    return { rev, key: `lobby/${rev}-k.zip`, url: "https://r2.test/put", headers: {} };
  }
  async commitBackup(req: LobbyCommitRequest): Promise<number> {
    this.events.push(`api:commitBackup ${req.rev}`);
    this.commits.push(req);
    this.latest = { rev: req.rev, sha256: req.sha256, size: req.size, url: `https://r2.test/lobby${req.rev}.zip` };
    return req.rev;
  }
  async latestBackup(): Promise<SnapshotRef | null> {
    this.events.push("api:latestBackup");
    return this.latest;
  }
}

export interface LobbyHarness {
  deps: LobbyDeps;
  api: FakeLobbyApi;
  events: string[];
  logs: string[];
  timers: ManualTimers;
  stop: StopSignal;
  servers: FakeServer[];
  exits: number[];
}

export function makeLobbyHarness(o: { fixtureZip?: string; fresh?: boolean } = {}): LobbyHarness {
  const events: string[] = [];
  const h: Omit<LobbyHarness, "deps"> = {
    api: new FakeLobbyApi(events),
    events,
    logs: [],
    timers: new ManualTimers(),
    stop: new StopSignal(),
    servers: [],
    exits: [],
  };
  const deps: LobbyDeps = {
    api: h.api,
    dataDir: mkdtempSync(join(tmpdir(), "mc-lobby-")),
    log: (line) => h.logs.push(line),
    address: () => "100.64.0.50",
    machine: "fedora",
    fresh: o.fresh ?? false,
    prepareServer: async (dir) => {
      events.push("prepare");
      mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, "server.properties"))) writeFileSync(join(dir, "server.properties"), "motd=Lobby\n");
    },
    ensureJava: async () => "/jre/bin/java",
    launch: () => {
      const s = new FakeServer(undefined, events);
      h.servers.push(s);
      return s;
    },
    forwardInput: () => {},
    download: async (url, dest) => {
      events.push(`download ${url}`);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(o.fixtureZip!, dest);
    },
    upload: async (target) => {
      events.push(`upload ${target.url}`);
    },
    onStopSignal: h.stop.on,
    crashSummary: async () => "Last 30 lines of logs/latest.log:\nboom",
    now: () => new Date(2026, 9, 3, 21, 0).getTime(),
    sleep: async () => {},
    timers: h.timers,
    exit: (code) => {
      h.exits.push(code);
    },
  };
  return { ...h, deps };
}

/** A zipped lobby folder: what a backup download delivers. */
export async function lobbyFixture(content = "from the backup") {
  const root = mkdtempSync(join(tmpdir(), "mc-lobby-fixture-"));
  const src = join(root, "src");
  mkdirSync(join(src, "world"), { recursive: true });
  writeFileSync(join(src, "world", "level.dat"), content);
  writeFileSync(join(src, "server.properties"), "motd=Backed up\n");
  const zip = join(root, "fixture.zip");
  return { zip, ...(await zipLobby(src, zip)) };
}
