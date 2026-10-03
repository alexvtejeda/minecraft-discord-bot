import { dependencyHints, jarName, jarProfileLine, parseLock, type JarSide, type JarTarget } from "@mc/profile";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { Attachment, Command, CommandContext } from "../discord/registry";
import { deferred, OOPS, reply } from "../discord/respond";
import { editOriginal } from "../discord/rest";
import { ApiError } from "../errors";
import { MAX_JAR_BYTES, storeJar } from "../jars";
import { activeWorld } from "../worlds";

const MB = 1024 * 1024;

export const modUpload: Command = {
  path: "mod upload",
  description: "Check a mod jar and store it, then get the line to add to a profile",
  maintainerOnly: true,
  options: [
    { type: ApplicationCommandOptionType.Attachment, name: "jar", description: "The mod's Fabric .jar file", required: true },
    {
      type: ApplicationCommandOptionType.String,
      name: "side",
      description: "Who needs it",
      required: true,
      choices: [
        { name: "Everyone (server and players)", value: "both" },
        { name: "Server only", value: "server" },
      ],
    },
    { type: ApplicationCommandOptionType.String, name: "name", description: "Its name in the profile (default: the mod's ID)", required: false },
  ],
  async run(c) {
    const att = c.attachments[String(c.options.jar)];
    if (!att) return reply("Attach the mod's .jar file.");
    if (!att.filename.endsWith(".jar")) return reply(`${att.filename} isn't a .jar file.`);
    if (att.size > MAX_JAR_BYTES) {
      return reply(`${att.filename} is over ${MAX_JAR_BYTES / MB} MB. Upload it with \`mc-host admin jar add <profile> <file.jar>\` instead.`);
    }
    const world = await activeWorld(c.env.DB);
    if (!world) {
      return reply("There's no active world to check the jar against. Use `mc-host admin jar add <profile> <file.jar>` instead.");
    }
    const lock = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
    const side: JarSide = c.options.side === "server" ? "server" : "both";
    const name = typeof c.options.name === "string" ? c.options.name : undefined;
    const have = lock.files.map((f) => f.slug);
    c.exec.waitUntil(finish(c, att, { minecraft: lock.minecraft, javaMajor: lock.javaMajor }, side, name, have));
    return deferred();
  },
};

async function finish(c: CommandContext, att: Attachment, target: JarTarget, side: JarSide, name: string | undefined, have: string[]): Promise<void> {
  let message: string;
  try {
    const res = await fetch(att.url);
    if (!res.ok) throw new ApiError("upstream", `Couldn't download ${att.filename} from Discord (HTTP ${res.status}). Try again.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { jar, created } = await storeJar(c.env, { bytes, filename: att.filename, target, by: c.userId, now: c.now });
    const line = jarProfileLine({ name: name ?? jarName(jar.modId, att.filename), filename: att.filename, sha512: jar.sha512, side });
    const what = [jar.modId, jar.version].filter(Boolean).join(" ") || "unknown mod";
    message = [
      created ? `Stored ${att.filename} (${what}).` : `${att.filename} was already stored (${what}).`,
      `Add this to the profile's "mods", run \`mc-host profile resolve <profile>\`, commit, deploy, then \`/world repin\`:`,
      "```json",
      line,
      "```",
      ...dependencyHints(jar.depends, have),
    ].join("\n");
  } catch (err) {
    if (!(err instanceof ApiError)) console.error("/mod upload failed", err);
    message = err instanceof ApiError ? err.message : OOPS;
  }
  await editOriginal(c.env, c.interactionToken, message).catch((err) => console.error("couldn't edit the /mod upload reply", err));
}
