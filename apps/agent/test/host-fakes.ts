import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { profileHash, type Lockfile, type Profile } from "@mc/profile";
import type { ClaimResponse, CommitRequest, LeaseInfo, Manifest, UploadTarget, UploadUrlRequest } from "@mc/protocol";
import { makeProfile } from "../../../packages/profile/test/fakes";
import { OfflineError, type AgentApi } from "../src/host/api";
import type { ServerProcess } from "../src/host/console";
import type { SessionDeps, Timers } from "../src/host/deps";
import { zipSnapshot } from "../src/host/snapshot";
import type { ServerMarker } from "../src/server/build";

/** Answer the commands a real server answers, asynchronously like a real process. */
export function defaultRespond(line: string, s: FakeServer): void {
  if (line === "save-all flush") queueMicrotask(() => s.emit("[Server thread/INFO]: Saved the game"));
  if (line === "stop") queueMicrotask(() => s.exit(0));
}

export class FakeServer implements ServerProcess {
  written: string[] = [];
  private listeners: ((line: string) => void)[] = [];
  private resolveExit!: (code: number) => void;
  exited = new Promise<number>((resolve) => (this.resolveExit = resolve));

  constructor(
    private respond: (line: string, s: FakeServer) => void = defaultRespond,
    private events?: string[],
  ) {}

  write(line: string): void {
    this.written.push(line);
    this.events?.push(`server:${line}`);
    this.respond(line, this);
  }

  onLine(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }

  emit(line: string): void {
    for (const cb of this.listeners) cb(line);
  }

  exit(code: number): void {
    this.resolveExit(code);
  }
}

export const SESSION = "session-0123456789";
export const MARKER: ServerMarker = { profile: "test", minecraft: "26.3", javaMajor: 25, memory: { min: "2G", max: "4G" }, complete: true };
export const DONE_LINE = '[Server thread/INFO]: Done (1.234s)! For help, type "help"';
export const CHUNKY_DONE_LINE = "[Server thread/INFO]: [Chunky] Task finished for minecraft:overworld. Processed: 100 chunks (100.00%)";

export async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (cond()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for a condition");
}

export async function worldFiles(over: Record<string, unknown> = {}): Promise<{ profile: Profile; lockfile: Lockfile }> {
  const profile = makeProfile(over);
  const lockfile: Lockfile = {
    lockfileVersion: 1,
    profile: profile.name,
    profileHash: await profileHash(profile),
    minecraft: profile.minecraft,
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files: [],
  };
  return { profile, lockfile };
}

export async function manifestFor(
  o: {
    worldId?: string;
    latest?: { rev: number; sha256: string; size: number } | null;
    pregenDone?: boolean;
    lease?: (LeaseInfo & { you: boolean }) | null;
    profile?: Record<string, unknown>;
  } = {},
): Promise<Manifest> {
  const { profile, lockfile } = await worldFiles(o.profile);
  return {
    world: { id: o.worldId ?? "w1", name: "test", minecraft: "26.3" },
    profile,
    lockfile,
    pregenDone: o.pregenDone ?? false,
    latest: o.latest ? { ...o.latest, url: `https://r2.test/rev${o.latest.rev}.zip` } : null,
    lease: o.lease ?? null,
  };
}

/** A zipped server folder: what a download delivers. */
export async function fixtureSnapshot(levelName = "world", content = "from the cloud") {
  const root = mkdtempSync(join(tmpdir(), "mc-fixture-"));
  mkdirSync(join(root, "src", levelName), { recursive: true });
  writeFileSync(join(root, "src", levelName, "level.dat"), content);
  const zip = join(root, "fixture.zip");
  return { zip, ...(await zipSnapshot(join(root, "src"), levelName, zip)) };
}

export class FakeApi implements AgentApi {
  latestRev: number;
  claimError: Error | null = null;
  heartbeatError: Error | null = null;
  uploadFailures = 0;
  commits: CommitRequest[] = [];

  constructor(
    public manifestValue: Manifest,
    private events: string[],
  ) {
    this.latestRev = manifestValue.latest?.rev ?? 0;
  }

  async manifest(): Promise<Manifest> {
    this.events.push("api:manifest");
    return this.manifestValue;
  }
  async claim(hostAddress: string): Promise<ClaimResponse> {
    this.events.push(`api:claim ${hostAddress}`);
    if (this.claimError) throw this.claimError;
    return { sessionId: SESSION, baseRev: this.latestRev, expiresAt: 0 };
  }
  async heartbeat(): Promise<void> {
    this.events.push("api:heartbeat");
    if (this.heartbeatError) throw this.heartbeatError;
  }
  async release(): Promise<void> {
    this.events.push("api:release");
  }
  async uploadUrl(req: UploadUrlRequest): Promise<UploadTarget> {
    this.events.push(`api:uploadUrl ${req.baseRev}`);
    if (this.uploadFailures > 0) {
      this.uploadFailures--;
      throw new OfflineError("Couldn't upload the world (offline).");
    }
    return { rev: req.baseRev + 1, key: `k${req.baseRev + 1}`, url: "https://r2.test/put", headers: {} };
  }
  async commit(req: CommitRequest): Promise<number> {
    this.events.push(`api:commit ${req.rev}${req.pregenDone ? " pregen" : ""}`);
    this.commits.push(req);
    this.latestRev = req.rev;
    return req.rev;
  }
}

export class ManualTimers implements Timers {
  private fns = new Map<number, Set<() => void>>();
  every(ms: number, fn: () => void): () => void {
    const set = this.fns.get(ms) ?? new Set();
    set.add(fn);
    this.fns.set(ms, set);
    return () => set.delete(fn);
  }
  fire(ms: number): void {
    for (const fn of [...(this.fns.get(ms) ?? [])]) fn();
  }
}

export class StopSignal {
  private handlers = new Set<() => void>();
  on = (handler: () => void) => {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  };
  fire(): void {
    for (const h of [...this.handlers]) h();
  }
  get count(): number {
    return this.handlers.size;
  }
}

export interface Harness {
  deps: SessionDeps;
  api: FakeApi;
  events: string[];
  logs: string[];
  answers: string[];
  timers: ManualTimers;
  stop: StopSignal;
  servers: FakeServer[];
  forwarded: { cb: ((line: string) => void) | null };
  exits: number[];
  builds: { profile: Profile; dir: string }[];
}

export function makeHarness(
  manifest: Manifest,
  o: { fixtureZip?: string; respond?: (line: string, s: FakeServer) => void } = {},
): Harness {
  const events: string[] = [];
  const h: Omit<Harness, "deps"> = {
    api: new FakeApi(manifest, events),
    events,
    logs: [],
    answers: [],
    timers: new ManualTimers(),
    stop: new StopSignal(),
    servers: [],
    forwarded: { cb: null },
    exits: [],
    builds: [],
  };
  const deps: SessionDeps = {
    api: h.api,
    dataDir: mkdtempSync(join(tmpdir(), "mc-session-")),
    log: (line) => h.logs.push(line),
    ask: async (q) => {
      events.push(`ask:${q}`);
      return h.answers.shift() ?? "";
    },
    address: () => "100.64.0.3",
    build: async (b) => {
      events.push("build");
      h.builds.push(b);
      mkdirSync(b.dir, { recursive: true });
      return MARKER;
    },
    ensureEula: async () => true,
    checkJava: () => {},
    launch: () => {
      const s = new FakeServer(o.respond, events);
      h.servers.push(s);
      return s;
    },
    forwardInput: (cb) => {
      h.forwarded.cb = cb;
    },
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
    now: () => new Date(2026, 8, 26, 21, 0).getTime(),
    sleep: async () => {},
    timers: h.timers,
    exit: (code) => {
      h.exits.push(code);
    },
  };
  return { ...h, deps };
}
