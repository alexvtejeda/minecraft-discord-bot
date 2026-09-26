import { ago, mention } from "./discord/format";
import { postMessage } from "./discord/rest";
import type { Env } from "./env";

export const GAME_PORT = 25565;
/** How long a released host's mc-host can take to notice: its heartbeat interval (agent HEARTBEAT_MS). */
export const HOST_NOTICE = "2 minutes";

/** Only waitUntil is needed; Hono's executionCtx type lacks the rest of workers-types' ExecutionContext. */
type Waiter = Pick<ExecutionContext, "waitUntil">;

/** Fire and forget: the request that triggered it never waits on Discord or fails because of it. */
function announce(env: Env, exec: Waiter, content: string, ping: string): void {
  if (!env.ANNOUNCE_CHANNEL_ID) return;
  exec.waitUntil(
    postMessage(env, env.ANNOUNCE_CHANNEL_ID, { content, allowed_mentions: { users: [ping] } }).catch((err) =>
      console.error("announcement failed", err),
    ),
  );
}

export function announceStarted(
  env: Env,
  exec: Waiter,
  o: { userId: string; worldName: string; minecraft: string; hostAddress: string },
): void {
  announce(
    env,
    exec,
    `🟢 ${mention(o.userId)} is hosting **${o.worldName}** (${o.minecraft}) at \`${o.hostAddress}:${GAME_PORT}\`. \`/join\` for how to connect.`,
    o.userId,
  );
}

export function announceStopped(env: Env, exec: Waiter, o: { userId: string; rev: number | null }): void {
  const saved = o.rev ? `World saved as rev ${o.rev}.` : "Nothing was saved yet.";
  announce(env, exec, `🔴 ${mention(o.userId)} stopped the server. ${saved}`, o.userId);
}

export function announceReleased(
  env: Env,
  exec: Waiter,
  o: { holderId: string; rev: number | null; savedAt: number | null; now: number },
): void {
  const saved =
    o.rev && o.savedAt !== null ? `The world is back to its last save: rev ${o.rev}, ${ago(o.now - o.savedAt)}.` : "The world was never saved.";
  announce(
    env,
    exec,
    `🔴 A maintainer released ${mention(o.holderId)}'s hosting session. If the server is still up, it shuts down within ${HOST_NOTICE}. ${saved}`,
    o.holderId,
  );
}
