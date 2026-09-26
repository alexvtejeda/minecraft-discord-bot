import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/run/config";
import { crashSummary, suspectMod } from "../src/run/crash";
import { ensureEula } from "../src/run/eula";
import { parseJavaMajor } from "../src/run/java";
import { whileChildRuns } from "../src/run/server";

test("parseJavaMajor handles modern and legacy version strings", () => {
  expect(parseJavaMajor('openjdk version "25.0.4" 2026-07-21\nOpenJDK Runtime')).toBe(25);
  expect(parseJavaMajor('java version "1.8.0_392"')).toBe(8);
  expect(parseJavaMajor('openjdk version "21" 2023-09-19')).toBe(21);
  expect(parseJavaMajor("command not found")).toBeNull();
});

describe("ensureEula", () => {
  let cfg: string;
  let server: string;
  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "mc-cfg-"));
    server = mkdtempSync(join(tmpdir(), "mc-srv-"));
  });

  test("asks once, remembers yes, writes eula.txt", async () => {
    const asked: string[] = [];
    const ask = async (q: string) => (asked.push(q), "YES ");
    expect(await ensureEula({ configDir: cfg, serverDir: server, ask, log: () => {} })).toBe(true);
    expect(readFileSync(join(server, "eula.txt"), "utf8")).toBe("eula=true\n");
    expect((await readConfig(cfg)).eulaAccepted).toBe(true);
    const server2 = mkdtempSync(join(tmpdir(), "mc-srv-"));
    expect(await ensureEula({ configDir: cfg, serverDir: server2, ask, log: () => {} })).toBe(true);
    expect(asked.length).toBe(1);
  });

  test("anything but yes refuses and writes nothing", async () => {
    expect(await ensureEula({ configDir: cfg, serverDir: server, ask: async () => "y", log: () => {} })).toBe(false);
    expect(existsSync(join(server, "eula.txt"))).toBe(false);
    expect((await readConfig(cfg)).eulaAccepted).toBeUndefined();
  });
});

describe("crash summary", () => {
  test("suspectMod finds Fabric dependency errors and suspected mods", () => {
    expect(suspectMod("Incompatible mods found!\n\t - Mod 'Waystones' (waystones) 26.3 requires any version of balm")).toBe("Waystones");
    expect(suspectMod("Suspected Mods: Lootr (lootr)")).toBe("Lootr (lootr)");
    expect(suspectMod("Suspected Mods: NONE")).toBeNull();
    expect(suspectMod("all fine")).toBeNull();
  });

  test("crashSummary tails the log and ignores crash reports older than the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-crash-"));
    mkdirSync(join(dir, "logs"));
    mkdirSync(join(dir, "crash-reports"));
    const log = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(dir, "logs", "latest.log"), log);
    const old = join(dir, "crash-reports", "crash-old.txt");
    writeFileSync(old, "Suspected Mods: OldMod (old)");
    utimesSync(old, new Date(2000, 0, 1), new Date(2000, 0, 1));
    const summary = await crashSummary(dir, Date.now() - 60_000);
    expect(summary).toContain("line 40");
    expect(summary).toContain("line 11");
    expect(summary).not.toContain("line 10\n");
    expect(summary).not.toContain("OldMod");
    writeFileSync(join(dir, "crash-reports", "crash-new.txt"), "Suspected Mods: Lootr (lootr)");
    expect(await crashSummary(dir, Date.now() - 60_000)).toContain("The crash looks related to: Lootr (lootr)");
  });

  test("crashSummary with no log says so", async () => {
    expect(await crashSummary(mkdtempSync(join(tmpdir(), "mc-empty-")))).toContain("exited before writing a log");
  });
});

// Final review I4
test("a corrupt agent config is a plain-English error", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "mc-cfg-"));
  writeFileSync(join(cfg, "config.json"), "{oops");
  await expect(readConfig(cfg)).rejects.toThrow(/config\.json is damaged/);
});

// Final review M8 (re-graded Important)
test("whileChildRuns ignores Ctrl+C in mc-host until the child exits", async () => {
  const before = process.listenerCount("SIGINT");
  let release!: () => void;
  const child = new Promise<number>((r) => (release = () => r(0)));
  const running = whileChildRuns(child);
  expect(process.listenerCount("SIGINT")).toBe(before + 1);
  process.emit("SIGINT");
  release();
  expect(await running).toBe(0);
  expect(process.listenerCount("SIGINT")).toBe(before);
});
