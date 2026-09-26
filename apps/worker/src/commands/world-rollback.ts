import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { confirmRow } from "../discord/confirm";
import { ago, savedBy } from "../discord/format";
import type { Command, ConfirmAction } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { KEEP_SNAPSHOTS, rollbackTo } from "../snapshots";
import { activeWorld, latestSnapshot, type SnapshotRow } from "../worlds";
import { hostingNow, NO_WORLD } from "./common";

type Kept = SnapshotRow & { by_name: string | null };

const kept = async (db: D1Database, worldId: string) =>
  (
    await db
      .prepare(
        `SELECT s.*, u.name AS by_name FROM snapshots s LEFT JOIN users u ON u.discord_id = s.uploaded_by
         WHERE s.world_id = ? ORDER BY s.rev DESC`,
      )
      .bind(worldId)
      .all<Kept>()
  ).results;

const byName = (s: Kept) => s.by_name ?? (s.uploaded_by.startsWith("rollback:") ? "a rollback" : "an import");

export const worldRollback: Command = {
  path: "world rollback",
  description: "Go back to an earlier save of the current world",
  maintainerOnly: true,
  options: [
    { type: ApplicationCommandOptionType.Integer, name: "rev", description: "Which save to go back to", required: true, min_value: 1, autocomplete: true },
  ],
  async autocomplete(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return [];
    const typed = String(c.options.rev ?? "");
    return (await kept(c.env.DB, world.id))
      .slice(1)
      .filter((s) => String(s.rev).startsWith(typed))
      .map((s) => ({ name: `rev ${s.rev} — ${ago(c.now - s.created_at)} by ${byName(s)}`.slice(0, 100), value: s.rev }));
  },
  async run(c) {
    const world = await activeWorld(c.env.DB);
    if (!world) return reply(NO_WORLD);
    const rev = Number(c.options.rev);
    const rows = await kept(c.env.DB, world.id);
    const target = rows.find((s) => s.rev === rev);
    const latest = rows[0];
    if (!target || !latest) {
      return reply(`Rev ${rev} isn't kept. Only the last ${KEEP_SNAPSHOTS} saves are kept, so pick one from the list.`);
    }
    if (rev === latest.rev) return reply(`Rev ${rev} is already the latest.`);
    const lease = await readLease(c.env.DB);
    if (isHeld(lease, c.now)) return reply(hostingNow(lease.holder_id!));
    return reply(
      [
        `Roll **${world.name}** back to rev ${rev} (saved ${ago(c.now - target.created_at)} by ${savedBy(target.uploaded_by)})?`,
        `This saves it again as rev ${latest.rev + 1}. Rev ${latest.rev} stays available, so you can roll forward again.`,
      ].join("\n"),
      confirmRow("rollback", [world.id, String(rev), String(latest.rev)], "Roll back"),
    );
  },
};

export const rollbackAction: ConfirmAction = {
  name: "rollback",
  async run(c, [worldId = "", rev = "", latestRev = ""]) {
    const world = await activeWorld(c.env.DB);
    const latest = world ? await latestSnapshot(c.env.DB, world.id) : null;
    if (!world || world.id !== worldId || String(latest?.rev) !== latestRev) return update(STALE);
    const newRev = await rollbackTo(c.env, { worldId, rev: Number(rev), by: c.userId, now: c.now });
    return update(`Rolled **${world.name}** back: rev ${newRev} is now a copy of rev ${rev}. The next \`mc-host start\` loads it.`);
  },
};
