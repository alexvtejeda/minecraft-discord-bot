import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const PATTERNS = [/Suspected Mods?:\s*([^\n]+)/i, /- Mod '([^']+)'/];

export function suspectMod(text: string): string | null {
  for (const p of PATTERNS) {
    const name = p.exec(text)?.[1]?.trim();
    if (name && !/^(none|unknown|minecraft)\b/i.test(name)) return name;
  }
  return null;
}

/** Last lines of logs/latest.log plus a hint from the newest crash report written since sinceMs. */
export async function crashSummary(serverDir: string, sinceMs = 0, lines = 30): Promise<string> {
  const logPath = join(serverDir, "logs", "latest.log");
  const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "";

  let report = "";
  const reportsDir = join(serverDir, "crash-reports");
  if (existsSync(reportsDir)) {
    const recent: { path: string; mtime: number }[] = [];
    for (const name of await readdir(reportsDir)) {
      const path = join(reportsDir, name);
      const { mtimeMs } = await stat(path);
      if (name.endsWith(".txt") && mtimeMs >= sinceMs) recent.push({ path, mtime: mtimeMs });
    }
    const newest = recent.sort((a, b) => b.mtime - a.mtime)[0];
    if (newest) report = await readFile(newest.path, "utf8");
  }

  const out: string[] = log
    ? [`Last ${lines} lines of logs/latest.log:`, ...log.trimEnd().split(/\r?\n/).slice(-lines)]
    : ["The server exited before writing a log."];
  const suspect = suspectMod(`${report}\n${log}`);
  if (suspect) {
    out.push("", `The crash looks related to: ${suspect}. Try removing it from the profile (or moving it to "waiting") and build again.`);
  }
  return out.join("\n");
}
