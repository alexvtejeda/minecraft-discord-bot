#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { UserError } from "@mc/profile";
import { runCommand } from "./commands";
import { cacheDir, configDir, dataDir } from "./paths";

export type Command =
  | { kind: "resolve"; name: string; check?: string; addReady: boolean; profilesDir: string }
  | { kind: "build-server"; name: string; dir: string; packsDir?: string; force: boolean; profilesDir: string }
  | { kind: "build-mrpack"; name: string; out: string; profilesDir: string }
  | { kind: "run"; dir: string }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "admin-world-create"; profile: string; name?: string; replace: boolean; importDir?: string; profilesDir: string }
  | { kind: "admin-token-mint"; discordId: string; name: string }
  | { kind: "admin-lease-release" }
  | { kind: "admin-status" }
  | { kind: "help" };

export const USAGE = `mc-host <command>

Hosting
  start
      Host the active world. Press Ctrl+C to stop and save it.
  stop
      How to stop hosting.
  status
      Show the active world and who is hosting.

Profiles
  profile resolve <profile> [--check <mc-version>] [--add-ready]
      Pin exact mod versions into profiles/<profile>.lock.json.
      --check        only report which mods exist for another Minecraft version
      --add-ready    move "waiting" mods that now have a build into "mods"
  profile build-server <profile> <dir> [--packs <folder>] [--force]
      Put the Fabric server, server-side mods and datapacks in <dir>.
      --force        build even if <dir> holds another profile's world
  profile build-mrpack <profile> <out.mrpack>
      Write a modpack that Prism Launcher can import.
  profile run <dir>
      Start a server folder made by build-server.

Maintainers (need MC_WORKER_URL and MC_ADMIN_SECRET)
  admin world create <profile> [--name <name>] [--replace] [--import <server-folder>]
      Make a new active world from profiles/<profile>.json and its lockfile.
      --replace      archive the current world first
      --import       upload an existing server folder as the world's first snapshot
  admin token mint <discord-id> <name>
      Print a new hosting token for someone. It's shown only once.
  admin lease release
      Free a stuck lease.
  admin status
      Show the active world, the lease and everyone with a token.

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
        name: { type: "string" },
        replace: { type: "boolean", default: false },
        import: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new UserError(`${(err as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [group, sub, a, b, c] = positionals;
  if (values.help || !group) return { kind: "help" };
  const profilesDir = values.profiles ?? "profiles";
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new UserError(`Missing ${what}.\n\n${USAGE}`);
    return v;
  };
  const unknown = (words: (string | undefined)[]) =>
    new UserError(`Unknown command "${words.filter(Boolean).join(" ")}".\n\n${USAGE}`);

  switch (group) {
    case "start":
    case "stop":
    case "status":
      return { kind: group };
    case "profile":
      switch (sub) {
        case undefined:
          return { kind: "help" };
        case "resolve":
          return { kind: "resolve", name: need(a, "<profile>"), check: values.check, addReady: values["add-ready"] ?? false, profilesDir };
        case "build-server":
          return { kind: "build-server", name: need(a, "<profile>"), dir: need(b, "<dir>"), packsDir: values.packs, force: values.force ?? false, profilesDir };
        case "build-mrpack":
          return { kind: "build-mrpack", name: need(a, "<profile>"), out: need(b, "<out.mrpack>"), profilesDir };
        case "run":
          return { kind: "run", dir: need(a, "<dir>") };
        default:
          throw unknown(["profile", sub]);
      }
    case "admin":
      if (sub === "world" && a === "create") {
        return {
          kind: "admin-world-create",
          profile: need(b, "<profile>"),
          name: values.name,
          replace: values.replace ?? false,
          importDir: values.import,
          profilesDir,
        };
      }
      if (sub === "token" && a === "mint") {
        return { kind: "admin-token-mint", discordId: need(b, "<discord-id>"), name: need(c, "<name>") };
      }
      if (sub === "lease" && a === "release") return { kind: "admin-lease-release" };
      if (sub === "status") return { kind: "admin-status" };
      throw unknown(["admin", sub, a]);
    default:
      throw unknown([group]);
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
      dataDir: dataDir(),
      env: process.env,
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
