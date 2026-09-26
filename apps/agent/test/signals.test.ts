import { expect, test } from "bun:test";
import { join } from "node:path";

// Bun 1.3.3 uninstalls the native signal handler when any one listener is removed, so a
// swapped-in handler never ran and `mc-host stop` killed mc-host outright (exit 130).
async function signalFixture(signal: NodeJS.Signals, mode = ""): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "stop-signal.ts"), mode], { stdout: "pipe" });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  proc.kill(signal);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return { code: await proc.exited, out };
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`a stop handler hooked after another was unhooked still gets ${signal}`, async () => {
    const { code, out } = await signalFixture(signal);
    expect(code).toBe(0);
    expect(out).toContain("run handler");
    expect(out).not.toContain("prepare handler");
  });
}

test("with every handler unhooked, the signal ends the process as usual", async () => {
  expect((await signalFixture("SIGINT", "unhooked")).code).toBe(130);
  expect((await signalFixture("SIGTERM", "unhooked")).code).toBe(143);
});
