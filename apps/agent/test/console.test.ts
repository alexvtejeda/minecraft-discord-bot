import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { javaCommand, LineSplitter, ServerConsole, spawnProcess } from "../src/host/console";
import { TerminalInput } from "../src/host/terminal";
import { FakeServer } from "./host-fakes";

test("LineSplitter joins partial chunks and handles CRLF", () => {
  const s = new LineSplitter();
  expect(s.push("[a] Do")).toEqual([]);
  expect(s.push("ne (1s)\r\n[b] x\n[c")).toEqual(["[a] Done (1s)", "[b] x"]);
  expect(s.push("]\n")).toEqual(["[c]"]);
});

test("waitFor resolves on the next matching line", async () => {
  const server = new FakeServer(() => {});
  const con = new ServerConsole(server);
  const saved = con.waitFor(/Saved the game/, 1_000);
  server.emit("[Server thread/INFO]: Saving the game");
  server.emit("[Server thread/INFO]: Saved the game");
  expect(await saved).toContain("Saved the game");
});

test("waitFor times out, and rejects when the server exits", async () => {
  const server = new FakeServer(() => {});
  const con = new ServerConsole(server);
  await expect(con.waitFor(/never/, 10)).rejects.toThrow("Timed out");
  const pending = con.waitFor(/never/, 60_000);
  server.exit(0);
  await expect(pending).rejects.toThrow("server stopped");
});

test("typed lines and injected commands reach the server as whole lines, in order", () => {
  const server = new FakeServer(() => {});
  const con = new ServerConsole(server);
  const source = new EventEmitter();
  const input = new TerminalInput(source);
  input.forwardTo((line) => con.send(line));
  source.emit("line", "say hello");
  con.send("save-off");
  source.emit("line", "list");
  expect(server.written).toEqual(["say hello", "save-off", "list"]);
});

test("ask takes the next line instead of forwarding it; EOF answers empty", async () => {
  const source = new EventEmitter();
  const input = new TerminalInput(source);
  const forwarded: string[] = [];
  input.forwardTo((l) => forwarded.push(l));
  const out: string[] = [];
  const answer = input.ask("Upload it now? [Y/n] ", (s) => out.push(s));
  source.emit("line", "n");
  expect(await answer).toBe("n");
  expect(forwarded).toEqual([]);
  expect(out).toEqual(["Upload it now? [Y/n] "]);
  const second = input.ask("again? ", () => {});
  source.emit("close");
  expect(await second).toBe("");
});

test("javaCommand uses the marker's memory and the Fabric launcher", () => {
  expect(javaCommand({ profile: "p", minecraft: "26.3", javaMajor: 25, memory: { min: "2G", max: "4G" }, complete: true })).toEqual([
    "java",
    "-Xms2G",
    "-Xmx4G",
    "-jar",
    "fabric-server-launch.jar",
    "nogui",
  ]);
});

test("spawnProcess pipes commands in and lines out", async () => {
  const echoed: string[] = [];
  const proc = spawnProcess([process.execPath, join(import.meta.dir, "fixtures", "echo-server.ts")], import.meta.dir, (t) => echoed.push(t));
  const con = new ServerConsole(proc);
  await con.waitFor(/Done \(/, 10_000);
  const got = con.waitFor(/^got list$/, 10_000);
  con.send("list");
  await got;
  con.send("stop");
  expect(await proc.exited).toBe(0);
  expect(echoed.join("")).toContain("got list");
});
