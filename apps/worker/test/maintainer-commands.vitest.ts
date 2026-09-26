import { serializeLock, type Lockfile } from "@mc/profile";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modDiff } from "../src/commands/world-repin";
import { claimLease, readLease } from "../src/lease";
import { bundledProfile } from "../src/profiles";
import { ALEX, announceEnv, button, captureDiscord, postInteraction, slash } from "./discord";
import { addSnapshot, addUser, addWorld, hostSince, lockEntry } from "./helpers";

const M = { maintainer: true };
const confirmId = (r: { body: any }) => r.body.data.components[0].components[0].custom_id as string;
const world = (id: string) => env.DB.prepare("SELECT * FROM worlds WHERE id = ?").bind(id).first<any>();

beforeEach(() => addUser(ALEX, "Alex"));
afterEach(() => vi.restoreAllMocks());

/** An active world pinned to an older copy of the bundled adventure lockfile, with a seed. */
async function oldAdventure(): Promise<Lockfile> {
  const b = (await bundledProfile("adventure"))!;
  // files[0] gets an older version, files[1] is left out (so re-pinning adds it), and gone-mod is extra.
  const [first, , ...rest] = b.lock.files;
  const old: Lockfile = {
    ...b.lock,
    files: [{ ...first!, versionId: "old-version", versionNumber: "0.0.1" }, ...rest, lockEntry("gone-mod", "both")],
  };
  const profile = { ...b.profile, properties: { ...b.profile.properties, "level-seed": "1234" } };
  await env.DB.prepare(
    "INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at) VALUES ('w1', 'w1', ?, ?, ?, 'active', 1, 1)",
  )
    .bind(b.lock.minecraft, JSON.stringify(profile), serializeLock(old))
    .run();
  return old;
}

describe("/world archive", () => {
  it("previews, then archives and keeps only the last save", async () => {
    await addWorld("w1");
    await addSnapshot("w1", 1);
    await addSnapshot("w1", 2);
    const preview = await postInteraction(slash("world archive", {}, M));
    expect(preview.body.data.content).toContain("Archive **w1**?");
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain("Archived **w1**");
    expect((await world("w1")).status).toBe("archived");
    expect((await env.DB.prepare("SELECT rev FROM snapshots").all()).results).toEqual([{ rev: 2 }]);
    expect((await postInteraction(slash("status"))).body.data.content).toContain("There's no active world");
  });

  it("refuses Confirm once someone starts hosting", async () => {
    await addWorld("w1");
    const preview = await postInteraction(slash("world archive", {}, M));
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() });
    expect((await postInteraction(button(confirmId(preview), M))).body.data.content).toContain("is hosting right now");
    expect((await world("w1")).status).toBe("active");
  });
});

describe("/world repin", () => {
  it("diffs mods by slug", async () => {
    const from = { files: [lockEntry("a", "both"), lockEntry("b", "both"), lockEntry("c", "server")] } as Lockfile;
    const to = { files: [lockEntry("a", "both", { versionId: "a-v2", versionNumber: "2.0.0" }), lockEntry("c", "server"), lockEntry("d", "both")] } as Lockfile;
    const d = modDiff(from, to);
    expect(d.added.map((f) => f.slug)).toEqual(["d"]);
    expect(d.removed.map((f) => f.slug)).toEqual(["b"]);
    expect(d.changed).toEqual([{ slug: "a", from: "1.0.0", to: "2.0.0" }]);
  });

  it("previews the diff, then re-pins and keeps the seed", async () => {
    const old = await oldAdventure();
    const b = (await bundledProfile("adventure"))!;
    const preview = await postInteraction(slash("world repin", {}, M));
    const text: string = preview.body.data.content;
    expect(text).toContain(`+ ${b.lock.files[1]!.slug}`);
    expect(text).toContain("− gone-mod");
    expect(text).toContain(`~ ${old.files[0]!.slug} 0.0.1 → ${b.lock.files[0]!.versionNumber}`);
    await postInteraction(button(confirmId(preview), M));
    const w = await world("w1");
    expect(w.lockfile_json).toBe(serializeLock(b.lock));
    expect(JSON.parse(w.profile_json).properties["level-seed"]).toBe("1234");
  });

  it("says when there's nothing to change", async () => {
    const b = (await bundledProfile("adventure"))!;
    await env.DB.prepare(
      "INSERT INTO worlds (id, name, mc_version, profile_json, lockfile_json, status, pregen_done, created_at) VALUES ('w1', 'w1', ?, ?, ?, 'active', 1, 1)",
    )
      .bind(b.lock.minecraft, JSON.stringify(b.profile), serializeLock(b.lock))
      .run();
    expect((await postInteraction(slash("world repin", {}, M))).body.data.content).toBe(
      "**w1** already matches this deploy's adventure lockfile.",
    );
  });

  it("refuses a different Minecraft version", async () => {
    await oldAdventure();
    await env.DB.prepare("UPDATE worlds SET mc_version = '26.2'").run();
    expect((await postInteraction(slash("world repin", {}, M))).body.data.content).toContain("Changing versions needs a new world");
  });

  it("refuses a profile this deploy doesn't have", async () => {
    await addWorld("w1");
    expect((await postInteraction(slash("world repin", {}, M))).body.data.content).toBe(
      "The test profile isn't in this deploy, so there's nothing to re-pin to.",
    );
  });
});

describe("/host release", () => {
  it("previews, releases, and announces", async () => {
    const posts = captureDiscord();
    await addWorld("w1");
    await addSnapshot("w1", 3, { at: Date.now() - 25 * 60_000 });
    await hostSince(ALEX, "w1", 2 * 3_600_000);
    const preview = await postInteraction(slash("host release", {}, M), { env: announceEnv() });
    expect(preview.body.data.content).toContain(`<@${ALEX}> has been hosting for 2h`);
    const done = await postInteraction(button(confirmId(preview), M), { env: announceEnv() });
    expect(done.body.data.content).toBe(`Released <@${ALEX}>'s session. Anyone can host now.`);
    expect((await readLease(env.DB)).holder_id).toBeNull();
    expect(posts.map((p) => p.body.content)).toEqual([
      `🔴 A maintainer released <@${ALEX}>'s hosting session. Last save: rev 3, 25 min ago.`,
    ]);
  });

  it("says when nobody is hosting", async () => {
    expect((await postInteraction(slash("host release", {}, M))).body.data.content).toBe(
      "Nobody is hosting, so there's nothing to release.",
    );
  });

  it("refuses a stale Confirm after the session changed", async () => {
    await addWorld("w1");
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() });
    const preview = await postInteraction(slash("host release", {}, M));
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.9", worldId: "w1", now: Date.now() });
    expect((await postInteraction(button(confirmId(preview), M))).body.data.content).toBe(
      "Things changed since the preview. Run the command again.",
    );
    expect((await readLease(env.DB)).host_address).toBe("100.64.0.9");
  });
});
