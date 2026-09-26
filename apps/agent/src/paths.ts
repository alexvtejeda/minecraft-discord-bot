import { homedir } from "node:os";
import { posix, win32 } from "node:path";

type Env = Record<string, string | undefined>;

export function cacheDir(env: Env = process.env, platform: string = process.platform, home = homedir()): string {
  if (platform === "win32") return win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), "mc-host", "cache");
  return posix.join(env.XDG_CACHE_HOME ?? posix.join(home, ".cache"), "mc-host");
}

export function configDir(env: Env = process.env, platform: string = process.platform, home = homedir()): string {
  if (platform === "win32") return win32.join(env.APPDATA ?? win32.join(home, "AppData", "Roaming"), "mc-host");
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), "mc-host");
}

/** Worlds, local state and recovered copies. MC_DATA_DIR wins (the Docker image sets it to /data). */
export function dataDir(env: Env = process.env, platform: string = process.platform, home = homedir()): string {
  if (env.MC_DATA_DIR) return env.MC_DATA_DIR;
  if (platform === "win32") return win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), "mc-host", "data");
  return posix.join(env.XDG_DATA_HOME ?? posix.join(home, ".local", "share"), "mc-host", "data");
}
