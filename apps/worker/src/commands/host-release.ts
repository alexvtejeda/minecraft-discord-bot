import { announceReleased, HOST_NOTICE } from "../announce";
import { confirmRow } from "../discord/confirm";
import { ago, duration, mention } from "../discord/format";
import type { Command, ConfirmAction } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { forceRelease, isHeld, LEASE_MS, readLease } from "../lease";
import { latestSnapshot } from "../worlds";

const SESSION_PREFIX = 16;

export const hostRelease: Command = {
  path: "host release",
  description: "Free a stuck hosting session so someone else can host",
  maintainerOnly: true,
  async run(c) {
    const lease = await readLease(c.env.DB);
    if (!isHeld(lease, c.now)) return reply("Nobody is hosting, so there's nothing to release.");
    const lastBeat = (lease.expires_at ?? c.now) - LEASE_MS;
    return reply(
      [
        `${mention(lease.holder_id!)} has been hosting for ${duration(c.now - (lease.claimed_at ?? c.now))}. Their last heartbeat was ${ago(c.now - lastBeat)}.`,
        `Releasing lets someone else host right away. If their server is still running, their mc-host stops it within ${HOST_NOTICE}, and play since their last save isn't uploaded.`,
      ].join("\n"),
      confirmRow("release", [lease.session_id!.slice(0, SESSION_PREFIX)], "Release"),
    );
  },
};

export const releaseAction: ConfirmAction = {
  name: "release",
  async run(c, [sessionPrefix = ""]) {
    const lease = await readLease(c.env.DB);
    if (!isHeld(lease, c.now) || !lease.session_id?.startsWith(sessionPrefix)) return update(STALE);
    const latest = lease.world_id ? await latestSnapshot(c.env.DB, lease.world_id) : null;
    await forceRelease(c.env.DB, c.now);
    announceReleased(c.env, c.exec, { holderId: lease.holder_id!, rev: latest?.rev ?? null, savedAt: latest?.created_at ?? null, now: c.now });
    return update(
      `Released ${mention(lease.holder_id!)}'s session, so anyone can host now. If their server is still running, their mc-host stops it within ${HOST_NOTICE} and keeps what wasn't saved on their PC instead of uploading it.`,
    );
  },
};
