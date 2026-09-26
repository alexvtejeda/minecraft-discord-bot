import { confirmRow } from "../discord/confirm";
import { ago } from "../discord/format";
import type { Command, ConfirmAction } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { activeWorld, archiveWorld, latestSnapshot } from "../worlds";
import { hostingNow, NO_WORLD } from "./common";

export const worldArchive: Command = {
  path: "world archive",
  description: "Retire the current world, keeping its last save",
  maintainerOnly: true,
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const lease = await readLease(c.env.DB);
    if (isHeld(lease, c.now)) return reply(hostingNow(lease.holder_id!));
    const latest = await latestSnapshot(c.env.DB, world.id);
    const saved = latest ? `Its last save (rev ${latest.rev}, ${ago(c.now - latest.created_at)}) is kept; older ones are deleted.` : "It was never saved.";
    return reply(
      [`Archive **${world.name}**? ${saved}`, "Nobody can host until a maintainer runs `/world new`."].join("\n"),
      confirmRow("archive", [world.id], "Archive"),
    );
  },
};

export const archiveAction: ConfirmAction = {
  name: "archive",
  async run(c, [worldId = ""]) {
    const world = await activeWorld(c.env.DB);
    if (!world || world.id !== worldId) return update(STALE);
    const lease = await readLease(c.env.DB);
    if (isHeld(lease, c.now)) return update(hostingNow(lease.holder_id!));
    await archiveWorld(c.env, world.id, c.now);
    return update(`Archived **${world.name}**. Start the next one with \`/world new\`.`);
  },
};
