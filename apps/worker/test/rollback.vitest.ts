import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimLease, LEASE_MS, readLease } from "../src/lease";
import { rollbackTo } from "../src/snapshots";
import { ALEX, autocomplete, button, postInteraction, slash } from "./discord";
import { addSnapshot, addUser, addWorld } from "./helpers";

const M = { maintainer: true };
const revs = async () =>
  (await env.DB.prepare("SELECT rev, r2_key, uploaded_by FROM snapshots WHERE world_id = 'w1' ORDER BY rev").all<any>()).results;
const confirmId = (r: { body: any }) => r.body.data.components[0].components[0].custom_id as string;

let keys: string[];
beforeEach(async () => {
  await addUser(ALEX, "Alex");
  await addWorld("w1");
  keys = [];
  for (let rev = 1; rev <= 5; rev++) keys.push(await addSnapshot("w1", rev, { at: Date.now() - (6 - rev) * 3_600_000 }));
});

describe("rollbackTo", () => {
  it("adds a new rev that shares the old object, and pruning keeps that object", async () => {
    expect(await rollbackTo(env, { worldId: "w1", rev: 1, by: ALEX, now: Date.now() })).toBe(6);
    const rows = await revs();
    expect(rows.map((r) => r.rev)).toEqual([2, 3, 4, 5, 6]);
    expect(rows.at(-1)).toMatchObject({ r2_key: keys[0], uploaded_by: `rollback:${ALEX}` });
    expect(await (await env.BUCKET.get(keys[0]!))!.text()).toBe("rev 1");
    expect(await env.BUCKET.head(keys[1]!)).not.toBeNull();
  });

  it("can undo a rollback by rolling back to the rev before it", async () => {
    await rollbackTo(env, { worldId: "w1", rev: 2, by: ALEX, now: Date.now() });
    expect(await rollbackTo(env, { worldId: "w1", rev: 5, by: ALEX, now: Date.now() })).toBe(7);
    expect((await revs()).at(-1)!.r2_key).toBe(keys[4]);
  });

  it("refuses the latest rev, a pruned rev, and while someone is hosting", async () => {
    const now = Date.now();
    await expect(rollbackTo(env, { worldId: "w1", rev: 5, by: ALEX, now })).rejects.toMatchObject({ code: "conflict" });
    await expect(rollbackTo(env, { worldId: "w1", rev: 99, by: ALEX, now })).rejects.toMatchObject({ code: "not_found" });
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now });
    await expect(rollbackTo(env, { worldId: "w1", rev: 2, by: ALEX, now })).rejects.toMatchObject({ code: "lease_held" });
    expect((await revs()).length).toBe(5);
  });

  it("clears an expired session so it can't heartbeat back and save over the rollback", async () => {
    const then = Date.now() - LEASE_MS - 60_000;
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: then });
    await rollbackTo(env, { worldId: "w1", rev: 2, by: ALEX, now: Date.now() });
    expect((await readLease(env.DB)).session_id).toBeNull();
  });
});

describe("/world rollback", () => {
  it("autocompletes the kept revs except the latest, newest first", async () => {
    const r = await postInteraction(autocomplete("world rollback", { rev: "" }, "rev", M));
    expect(r.body.data.choices.map((c: any) => c.value)).toEqual([4, 3, 2, 1]);
    expect(r.body.data.choices[0].name).toBe("rev 4 — 2h ago by Alex");
    for (const c of r.body.data.choices) expect(c.name.length).toBeLessThanOrEqual(100);
  });

  it("filters autocomplete by what's typed", async () => {
    const r = await postInteraction(autocomplete("world rollback", { rev: "3" }, "rev", M));
    expect(r.body.data.choices.map((c: any) => c.value)).toEqual([3]);
  });

  it("previews, then rolls back on Confirm", async () => {
    const preview = await postInteraction(slash("world rollback", { rev: 2 }, M));
    expect(preview.body.data.content).toContain("Roll **w1** back to rev 2");
    expect(preview.body.data.content).toContain("saves it again as rev 6");
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain("rev 6 is now a copy of rev 2");
    expect((await revs()).at(-1)).toMatchObject({ rev: 6, r2_key: keys[1] });
  });

  it("refuses Confirm if a save landed after the preview", async () => {
    const preview = await postInteraction(slash("world rollback", { rev: 2 }, M));
    await addSnapshot("w1", 6);
    expect((await postInteraction(button(confirmId(preview), M))).body.data.content).toBe(
      "Things changed since the preview. Run the command again.",
    );
    expect((await revs()).at(-1)!.rev).toBe(6);
  });

  it("explains a rev that isn't kept, and the latest rev", async () => {
    expect((await postInteraction(slash("world rollback", { rev: 99 }, M))).body.data.content).toContain("Rev 99 isn't kept");
    expect((await postInteraction(slash("world rollback", { rev: 5 }, M))).body.data.content).toBe("Rev 5 is already the latest.");
  });
});
