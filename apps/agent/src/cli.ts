#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { UserError } from "@mc/profile";
import { runCommand } from "./commands";
import { cacheDir, configDir } from "./paths";

export type Command =
  | { kind: "resolve"; name: string; check?: string; addReady: boolean; profilesDir: string }
  | { kind: "build-server"; name: string; dir: string; packsDir?: string; force: boolean; profilesDir: string }
  | { kind: "build-mrpack"; name: string; out: string; profilesDir: string }
  | { kind: "run"; dir: string }
  | { kind: "help" };

export const USAGE = `mc-host profile <command>

  resolve <profile> [--check <mc-version>] [--add-ready]
      Pin exact mod versions into profiles/<profile>.lock.json.
      --check        only report which mods exist for another Minecraft version
      --add-ready    move "waiting" mods that now have a build into "mods"
  build-server <profile> <dir> [--packs <folder>] [--force]
      Put the Fabric server, server-side mods and datapacks in <dir>.
      --force        build even if <dir> holds another profile's world
  build-mrpack <profile> <out.mrpack>
      Write a modpack that Prism Launcher can import.
  run <dir>
      Start a server folder made by build-server.

Options: --profiles <folder> (default: profiles)`;

export function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        check: { type: "string" },
        "add-ready": { type: "boolean", default: false },
        packs: { type: "string" },
        force: { type: "boolean", default: false },
        profiles: { type: "string", default: "profiles" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new UserError(`${(err as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [group, sub, a, b] = positionals;
  if (values.help || group !== "profile" || !sub) return { kind: "help" };
  const profilesDir = values.profiles ?? "profiles";
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new UserError(`Missing ${what}.\n\n${USAGE}`);
    return v;
  };
  switch (sub) {
    case "resolve":
      return { kind: "resolve", name: need(a, "<profile>"), check: values.check, addReady: values["add-ready"] ?? false, profilesDir };
    case "build-server":
      return { kind: "build-server", name: need(a, "<profile>"), dir: need(b, "<dir>"), packsDir: values.packs, force: values.force ?? false, profilesDir };
    case "build-mrpack":
      return { kind: "build-mrpack", name: need(a, "<profile>"), out: need(b, "<out.mrpack>"), profilesDir };
    case "run":
      return { kind: "run", dir: need(a, "<dir>") };
    default:
      throw new UserError(`Unknown command "profile ${sub}".\n\n${USAGE}`);
  }
}

async function main(): Promise<void> {
  try {
    const cmd = parseCommand(process.argv.slice(2));
    if (cmd.kind === "help") {
      console.log(USAGE);
      return;
    }
    await runCommand(cmd, {
      fetch: (input, init) => fetch(input, init),
      cacheDir: cacheDir(),
      configDir: configDir(),
      log: (line) => console.log(line),
      ask: async (q) => prompt(q) ?? "",
    });
  } catch (err) {
    if (err instanceof UserError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err);
    process.exit(2);
  }
}

if (import.meta.main) await main();
