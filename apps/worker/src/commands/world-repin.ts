import { parseLock, serializeLock, sha256Hex, type LockEntry, type Lockfile, type Profile } from "@mc/profile";
import { confirmRow } from "../discord/confirm";
import type { Command, ConfirmAction, Invocation } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { bundledProfile, withSeed, type Bundled } from "../profiles";
import { activeWorld, repinWorld, type WorldRow } from "../worlds";
import { hostingNow, NO_WORLD } from "./common";

export interface ModDiff {
  added: LockEntry[];
  removed: LockEntry[];
  changed: { slug: string; from: string; to: string }[];
}

export function modDiff(from: Lockfile, to: Lockfile): ModDiff {
  const before = new Map(from.files.map((f) => [f.slug, f]));
  const after = new Set(to.files.map((f) => f.slug));
  return {
    added: to.files.filter((f) => !before.has(f.slug)),
    removed: from.files.filter((f) => !after.has(f.slug)),
    changed: to.files.flatMap((f) => {
      const old = before.get(f.slug);
      return old && old.versionId !== f.versionId ? [{ slug: f.slug, from: old.versionNumber, to: f.versionNumber }] : [];
    }),
  };
}

const lockHash = async (lock: Lockfile) => (await sha256Hex(serializeLock(lock))).slice(0, 12);

type Plan = { world: WorldRow; bundled: Bundled; current: Lockfile } | { message: string };

async function plan(c: Invocation): Promise<Plan> {
  const world = await activeWorld(c.env.DB);
  if (!world) return { message: NO_WORLD };
  const profileName = (JSON.parse(world.profile_json) as Profile).name;
  const bundled = await bundledProfile(profileName);
  if (!bundled) return { message: `The ${profileName} profile isn't in this deploy, so there's nothing to re-pin to.` };
  if (bundled.lock.minecraft !== world.mc_version) {
    return {
      message: `This deploy's ${profileName} lockfile is for ${bundled.lock.minecraft}, but **${world.name}** is on ${world.mc_version}. Changing versions needs a new world: \`/world new\`.`,
    };
  }
  const current = parseLock(world.lockfile_json, `the ${world.name} lockfile`);
  if (serializeLock(current) === serializeLock(bundled.lock)) {
    return { message: `**${world.name}** already matches this deploy's ${profileName} lockfile.` };
  }
  const lease = await readLease(c.env.DB);
  if (isHeld(lease, c.now)) return { message: hostingNow(lease.holder_id!) };
  return { world, bundled, current };
}

export const worldRepin: Command = {
  path: "world repin",
  description: "Update the current world's mods to this deploy's lockfile",
  maintainerOnly: true,
  async run(c) {
    const p = await plan(c);
    if ("message" in p) return reply(p.message);
    const d = modDiff(p.current, p.bundled.lock);
    const lines = [
      ...d.added.map((f) => `+ ${f.slug} ${f.versionNumber}`),
      ...d.removed.map((f) => `− ${f.slug} ${f.versionNumber}`),
      ...d.changed.map((ch) => `~ ${ch.slug} ${ch.from} → ${ch.to}`),
    ];
    if (p.current.fabricLoader !== p.bundled.lock.fabricLoader) {
      lines.push(`~ Fabric loader ${p.current.fabricLoader} → ${p.bundled.lock.fabricLoader}`);
    }
    if (!lines.length) lines.push("(Only mod sides or dependencies changed.)");
    return reply(
      [
        `Re-pin **${p.world.name}** to this deploy's ${p.bundled.name} lockfile?`,
        "```diff",
        ...lines,
        "```",
        "Players need the updated modpack afterwards (`/modpack`). The next `mc-host start` uses the new mods.",
      ].join("\n"),
      confirmRow("repin", [p.world.id, await lockHash(p.bundled.lock)], "Re-pin"),
    );
  },
};

export const repinAction: ConfirmAction = {
  name: "repin",
  async run(c, [worldId = "", hash = ""]) {
    const p = await plan(c);
    if ("message" in p) return update(p.message);
    if (p.world.id !== worldId || (await lockHash(p.bundled.lock)) !== hash) return update(STALE);
    const seed = (JSON.parse(p.world.profile_json) as Profile).properties["level-seed"];
    await repinWorld(c.env.DB, { worldId, profile: withSeed(p.bundled.profile, seed), lock: p.bundled.lock, now: c.now });
    return update(`Re-pinned **${p.world.name}**. Everyone should grab the updated modpack with \`/modpack\`.`);
  },
};
