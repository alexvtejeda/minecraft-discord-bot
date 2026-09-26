import type { Lockfile, Profile } from "@mc/profile";
import type { ServerMarker } from "../server/build";
import type { AgentApi } from "./api";
import type { ServerProcess } from "./console";

export const HEARTBEAT_MS = 2 * 60_000;
export const AUTOSAVE_MS = 30 * 60_000;
export const SAVE_TIMEOUT_MS = 2 * 60_000;
export const UPLOAD_ATTEMPTS = 3;
export const DOWNLOAD_ATTEMPTS = 3;
export const PREGEN_RADIUS = 2000;

export interface Timers {
  /** Call fn every ms milliseconds; returns a function that stops it. */
  every(ms: number, fn: () => void): () => void;
}

/** Everything the hosting session touches outside its own logic. Tests swap in fakes. */
export interface SessionDeps {
  api: AgentApi;
  dataDir: string;
  log: (line: string) => void;
  ask: (question: string) => Promise<string>;
  address: () => string;
  build: (o: { profile: Profile; lock: Lockfile; dir: string }) => Promise<ServerMarker>;
  ensureEula: (serverDir: string) => Promise<boolean>;
  /** Path to a Java for this Minecraft version, downloading it the first time. */
  ensureJava: (need: { minecraft: string; javaMajor: number }) => Promise<string>;
  launch: (dir: string, marker: ServerMarker, javaBin: string) => ServerProcess;
  forwardInput: (cb: ((line: string) => void) | null) => void;
  download: (url: string, dest: string) => Promise<void>;
  upload: (target: { url: string; headers: Record<string, string> }, file: string) => Promise<void>;
  onStopSignal: (handler: () => void) => () => void;
  crashSummary: (serverDir: string, sinceMs: number) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timers: Timers;
  exit: (code: number) => void;
}

/** "" takes the default; otherwise y/yes means yes. */
export function yes(answer: string, byDefault: boolean): boolean {
  const a = answer.trim().toLowerCase();
  return a === "" ? byDefault : a === "y" || a === "yes";
}

export const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
