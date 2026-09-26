import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { confirmRow } from "../discord/confirm";
import { mention } from "../discord/format";
import type { Command, ConfirmAction } from "../discord/registry";
import { reply, STALE, update } from "../discord/respond";
import { isHeld, readLease } from "../lease";
import { deleteDevice, TailscaleError } from "../tailscale";
import { revokeUser } from "../users";

interface DeviceRow {
  node_id: string;
  hostname: string;
}

const devicesOf = async (db: D1Database, discordId: string) =>
  (await db.prepare("SELECT node_id, hostname FROM devices WHERE discord_id = ? ORDER BY created_at").bind(discordId).all<DeviceRow>()).results;

const HOSTING = "They're hosting right now. Their token stops working at once, and the session ends within 10 minutes, as after a crash.";

export const tailnetRevoke: Command = {
  path: "tailnet revoke",
  description: "Remove someone from the Minecraft network and block their hosting token",
  maintainerOnly: true,
  options: [{ type: ApplicationCommandOptionType.User, name: "user", description: "Who to remove", required: true }],
  async run(c) {
    const id = String(c.options.user ?? "");
    const devices = await devicesOf(c.env.DB, id);
    const lease = await readLease(c.env.DB);
    const hosting = isHeld(lease, c.now) && lease.holder_id === id;
    const what = devices.length
      ? `This deletes ${devices.length === 1 ? "their device" : `their ${devices.length} devices`} (${devices.map((d) => `\`${d.hostname}\``).join(", ")}) from the tailnet and blocks their hosting token.`
      : "They have no devices on record, so this blocks their hosting token and any setup link. Remove stray devices in the Tailscale admin console.";
    return reply(
      [`Remove ${mention(id)} from the Minecraft network?`, what, ...(hosting ? [HOSTING] : [])].join("\n"),
      confirmRow("revoke", [id], "Remove"),
    );
  },
};

export const revokeAction: ConfirmAction = {
  name: "revoke",
  async run(c, [id = ""]) {
    if (!/^\d+$/.test(id)) return update(STALE);
    // Block first: that part can't fail halfway, and a rerun finishes the devices.
    await revokeUser(c.env.DB, id, c.now);
    await c.env.DB.prepare("DELETE FROM enrollments WHERE discord_id = ?").bind(id).run();
    const devices = await devicesOf(c.env.DB, id);
    for (const d of devices) {
      try {
        await deleteDevice(c.env, d.node_id);
      } catch (err) {
        if (!(err instanceof TailscaleError)) throw err;
        console.error(err.message);
        return update(
          `Blocked ${mention(id)}'s hosting token and setup links, but couldn't reach Tailscale to remove \`${d.hostname}\`. Run \`/tailnet revoke\` again in a minute to finish.`,
        );
      }
      await c.env.DB.prepare("DELETE FROM devices WHERE node_id = ?").bind(d.node_id).run();
    }
    const removed = devices.length === 1 ? "1 device" : `${devices.length} devices`;
    return update(
      `Removed ${mention(id)} from the Minecraft network: ${removed} deleted, hosting token blocked. To let them back in, run \`mc-host admin token mint ${id} <name>\`, then they run \`/setup\`.`,
    );
  },
};
