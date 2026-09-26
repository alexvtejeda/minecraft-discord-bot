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
