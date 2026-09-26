import { WorldNameSchema } from "@mc/protocol";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { confirmRow } from "../discord/confirm";
import { ago } from "../discord/format";
import type { Command, ConfirmAction, Invocation } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { BUNDLED_NAMES, bundledProfile, withSeed } from "../profiles";
import { activeWorld, createWorld, latestSnapshot } from "../worlds";
import { hostingNow } from "./common";

const NAME_MAX = 30;
const SEED_MAX = 32;

/** The reason a new world can't be created right now, or null. */
async function problem(c: Invocation, name: string, profileName: string, seed: string): Promise<string | null> {
  // Discord enforces these too; checking here keeps the Confirm button's custom_id under 100 characters.
  if (name.length > NAME_MAX) return `World names can be up to ${NAME_MAX} characters here.`;
  if (seed.length > SEED_MAX) return `Seeds can be up to ${SEED_MAX} characters.`;
  const valid = WorldNameSchema.safeParse(name);
  if (!valid.success) return `World names ${valid.error.issues[0]!.message}.`;
  if (await c.env.DB.prepare("SELECT 1 FROM worlds WHERE name = ?").bind(name).first()) {
    return `A world called "${name}" already exists. Pick another name.`;
  }
  if (!(await bundledProfile(profileName))) return `There's no profile called "${profileName}" in this deploy.`;
  const lease = await readLease(c.env.DB);
  if (isHeld(lease, c.now)) return hostingNow(lease.holder_id!);
  return null;
}

async function create(c: Invocation, name: string, profileName: string, seed: string, replace: boolean): Promise<string> {
  const b = (await bundledProfile(profileName))!;
  await createWorld(c.env, { name, profile: withSeed(b.profile, seed), lock: b.lock, replace, imported: false, now: c.now });
  return `Created **${name}** (${b.lock.minecraft}, ${profileName} profile). The first \`mc-host start\` pre-generates the map, which takes a while.`;
}

export const worldNew: Command = {
  path: "world new",
  description: "Start a new world from one of the bundled profiles",
  maintainerOnly: true,
  options: [
    { type: ApplicationCommandOptionType.String, name: "name", description: "Lowercase letters, digits and dashes", required: true, max_length: NAME_MAX },
    {
      type: ApplicationCommandOptionType.String,
      name: "profile",
      description: "Which mods and settings",
      required: true,
      choices: BUNDLED_NAMES.map((n) => ({ name: n, value: n })),
    },
    { type: ApplicationCommandOptionType.String, name: "seed", description: "Leave empty for a random seed", max_length: SEED_MAX },
  ],
  async run(c) {
    const name = String(c.options.name);
    const profileName = String(c.options.profile);
    const seed = c.options.seed === undefined ? "" : String(c.options.seed);
    const why = await problem(c, name, profileName, seed);
    if (why) return reply(why);
    const current = await activeWorld(c.env.DB);
    if (!current) return reply(await create(c, name, profileName, seed, false));
    const latest = await latestSnapshot(c.env.DB, current.id);
    const b = (await bundledProfile(profileName))!;
    const saved = latest ? `(rev ${latest.rev}, saved ${ago(c.now - latest.created_at)})` : "(never saved)";
    return reply(
      [
        `This archives **${current.name}** ${saved} and starts **${name}** on ${b.lock.minecraft} with the ${profileName} profile${seed ? `, seed \`${seed}\`` : ""}.`,
        "Archived worlds keep only their last save.",
      ].join("\n"),
      confirmRow("new", [current.id.slice(0, 8), name, profileName, seed], "Archive and create"),
    );
  },
};

export const newAction: ConfirmAction = {
  name: "new",
  async run(c, [activePrefix = "", name = "", profileName = "", ...seedParts]) {
    const current = await activeWorld(c.env.DB);
    if (!current || !current.id.startsWith(activePrefix)) return update(STALE);
    const seed = seedParts.join(":");
    const why = await problem(c, name, profileName, seed);
    if (why) return update(why);
    return update(await create(c, name, profileName, seed, true));
  },
};
