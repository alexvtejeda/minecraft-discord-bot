import { mentions, provides, type PackIndex } from "./index";

/** One logged error: the header message, then its continuation lines without stack frames. */
export interface LogError {
  lines: string[];
}

const HEADER = /^\[\d{2}:\d{2}:\d{2}\] \[[^\]]*\/(ERROR|FATAL|WARN|INFO|DEBUG|TRACE)\]: (.*)$/;
const DATA_WARN = /data ?pack|failed to (load|parse)|couldn't (load|parse)|parsing error|incompatible/i;
/** Means the server gave up; the boot's "started" flag reports it, so it isn't an error to blame. */
const GAVE_UP = /Failed to load datapacks, can't proceed/;
const STACK = /^\s+at |^\s*\.\.\. \d+ more\s*$/;
const RESOURCE_ID = /(?<![\w.\/-])([a-z0-9_.-]+:[a-z0-9_.\/-]+)/g;
const PACK_FILE = /file\/(.+?\.zip)/gi;

export function scanLog(lines: string[]): LogError[] {
  const out: LogError[] = [];
  let current: LogError | null = null;
  for (const line of lines) {
    const m = HEADER.exec(line);
    if (m) {
      const [, level, message] = m as unknown as [string, string, string];
      const keep = (level === "ERROR" || level === "FATAL" || (level === "WARN" && DATA_WARN.test(message))) && !GAVE_UP.test(message);
      current = keep ? { lines: [message] } : null;
      if (current) out.push(current);
      continue;
    }
    if (current && line.trim() && !STACK.test(line)) current.lines.push(line.trimEnd());
  }
  return out;
}

/** Compare errors across boots: same text, whatever the numbers in it. */
export function errorKey(e: LogError): string {
  return e.lines
    .join("\n")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/@[0-9a-f]+\b/gi, "@#")
    .replace(/\d+/g, "#");
}

export function resourceIds(line: string): string[] {
  return [...line.matchAll(RESOURCE_ID)].map((m) => m[1]!);
}

export function packFileMentions(line: string): string[] {
  return [...line.matchAll(PACK_FILE)].map((m) => m[1]!);
}

function blamedBy(line: string, packs: PackIndex[]): string[] {
  const files = packFileMentions(line);
  const ids = resourceIds(line);
  return packs.filter((p) => files.includes(p.file) || ids.some((id) => provides(p, id) || mentions(p, id))).map((p) => p.file);
}

/** Which packs each error line points at. Errors whose lines point at none are unattributed. */
export function attribute(errors: LogError[], packs: PackIndex[]): { blamed: Map<string, string[]>; unattributed: LogError[] } {
  const blamed = new Map<string, string[]>();
  const unattributed: LogError[] = [];
  for (const e of errors) {
    let hit = false;
    for (const line of e.lines) {
      for (const file of blamedBy(line, packs)) {
        hit = true;
        const lines = blamed.get(file) ?? [];
        if (!lines.includes(line)) lines.push(line);
        blamed.set(file, lines);
      }
    }
    if (!hit) unattributed.push(e);
  }
  return { blamed, unattributed };
}

const FABRIC_REPORT = /Incompatible mods? found|Some of your mods are incompatible|Mod resolution failed/i;
const FABRIC_ITEM = /^\s*-\s+(.+)$/;

/** The " - …" items of Fabric's incompatible-mods report: what's missing or clashing. */
export function fabricModProblems(lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (FABRIC_REPORT.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (STACK.test(line) || HEADER.test(line)) {
      inside = false;
      continue;
    }
    const item = FABRIC_ITEM.exec(line)?.[1]?.trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}
