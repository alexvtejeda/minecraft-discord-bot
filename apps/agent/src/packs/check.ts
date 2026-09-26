import { UserError } from "@mc/profile";
import { packNameFromFilename } from "../server/packs";
import type { PackIndex } from "./index";
import { attribute, errorKey, scanLog, type LogError } from "./logscan";

export interface BootResult {
  lines: string[];
  /** The log reached "Done (". */
  started: boolean;
}

/** Boot the scratch server with exactly these pack files; label names the boot's log file. */
export type Boot = (packFiles: string[], label: string) => Promise<BootResult>;

export interface CheckReport {
  /** Every pack checked, sorted. */
  packs: string[];
  /** Pack file → the log lines that blamed it. */
  failed: Map<string, string[]>;
  /** Packs that pass alone but not together, with the errors nobody could be blamed for. */
  together: { files: string[]; lines: string[] } | null;
  boots: number;
}

const DIDNT_START = "The server didn't finish starting.";
const EVIDENCE_LINES = 3;
const EVIDENCE_CHARS = 300;

const linesOf = (errors: LogError[]) => errors.flatMap((e) => e.lines);

export async function checkPacks(packs: PackIndex[], boot: Boot, log: (line: string) => void): Promise<CheckReport> {
  let boots = 0;
  const run = (files: string[], label: string) => {
    boots++;
    return boot(files, label);
  };

  log("Booting without datapacks first, to see which errors the mods cause on their own…");
  const base = await run([], "baseline");
  const baseErrors = scanLog(base.lines);
  if (!base.started) {
    const last = linesOf(baseErrors).slice(-5);
    throw new UserError(
      `The server doesn't start even without datapacks, so the packs can't be checked. Fix that first.${last.length ? `\n${last.join("\n")}` : ""}`,
    );
  }
  const known = new Set(baseErrors.map(errorKey));
  const fresh = (r: BootResult) => scanLog(r.lines).filter((e) => !known.has(errorKey(e)));

  const failed = new Map<string, string[]>();
  let together: CheckReport["together"] = null;
  let remaining = packs;
  while (remaining.length) {
    log(`Booting with ${remaining.length} datapacks…`);
    const r = await run(remaining.map((p) => p.file), "all");
    const errors = fresh(r);
    if (r.started && errors.length === 0) break;

    const { blamed, unattributed } = attribute(errors, remaining);
    if (blamed.size) {
      for (const [file, lines] of blamed) failed.set(file, lines);
      remaining = remaining.filter((p) => !blamed.has(p.file));
      continue;
    }

    log(`Some errors don't point at a pack, so each of the ${remaining.length} datapacks is booted on its own…`);
    const alone = new Map<string, string[]>();
    for (const p of remaining) {
      const r1 = await run([p.file], `alone-${packNameFromFilename(p.file) ?? p.file}`);
      const e1 = fresh(r1);
      if (!r1.started || e1.length) alone.set(p.file, e1.length ? linesOf(e1) : [DIDNT_START]);
    }
    if (alone.size === 0) {
      const lines = linesOf(unattributed);
      together = { files: remaining.map((p) => p.file), lines: lines.length ? lines : [DIDNT_START] };
      break;
    }
    for (const [file, lines] of alone) failed.set(file, lines);
    remaining = remaining.filter((p) => !alone.has(p.file));
  }
  return { packs: packs.map((p) => p.file).sort(), failed, together, boots };
}

const cut = (line: string) => (line.length > EVIDENCE_CHARS ? `${line.slice(0, EVIDENCE_CHARS - 1)}…` : line);
const evidence = (lines: string[]) => lines.slice(0, EVIDENCE_LINES).map((l) => `        ${cut(l)}`);

export function formatReport(r: CheckReport): { lines: string[]; summary: string; ok: boolean } {
  const lines: string[] = [];
  for (const file of r.packs) {
    const bad = r.failed.get(file);
    lines.push(`  ${bad ? "FAIL" : "ok  "}  ${file}`);
    if (bad) lines.push(...evidence(bad));
  }
  if (r.together) {
    lines.push(`These datapacks only fail together: ${r.together.files.join(", ")}`);
    lines.push(...evidence(r.together.lines));
  }
  const n = r.packs.length;
  const boots = `(${r.boots} boots)`;
  if (r.together) {
    return { lines, summary: `${r.failed.size} of ${n} datapacks have errors on their own, but ${r.together.files.length} fail together ${boots}.`, ok: false };
  }
  if (r.failed.size) return { lines, summary: `${r.failed.size} of ${n} datapacks have errors ${boots}.`, ok: false };
  return { lines, summary: `${n === 1 ? "The datapack" : `All ${n} datapacks`} loaded without errors ${boots}.`, ok: true };
}
