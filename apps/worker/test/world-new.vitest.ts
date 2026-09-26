import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimLease, readLease } from "../src/lease";
import { BUNDLED_NAMES, bundledProfile, bundledProfiles } from "../src/profiles";
import { createWorld } from "../src/worlds";
import { ALEX, button, postInteraction, slash } from "./discord";
import { addSnapshot, addUser, addWorld } from "./helpers";

const M = { maintainer: true };
const worlds = () => env.DB.prepare("SELECT name, status, profile_json, lockfile_json FROM worlds ORDER BY created_at, name").all<any>();
const confirmId = (r: { body: any }) => r.body.data.components[0].components[0].custom_id as string;

beforeEach(() => addUser(ALEX, "Alex"));

describe("bundled profiles", () => {
  it("every committed profile matches its lockfile, and names fit the confirm budget", async () => {
    const all = await bundledProfiles();
    expect(all.map((b) => b.name)).toEqual(BUNDLED_NAMES);
    expect(BUNDLED_NAMES).toEqual(expect.arrayContaining(["adventure", "vanilla-plus"]));
    for (const n of BUNDLED_NAMES) expect(n.length).toBeLessThanOrEqual(20);
  });
});

describe("/world new", () => {
  it("needs the maintainer role", async () => {
    expect((await postInteraction(slash("world new", { name: "spring", profile: "adventure" }))).body.data.content).toBe(
      "That needs the MC Maintainer role.",
    );
  });

  it("creates right away when no world is active, with the seed in the profile", async () => {
    const r = await postInteraction(slash("world new", { name: "spring", profile: "vanilla-plus", seed: "-42" }, M));
    expect(r.body.data.content).toContain("Created **spring** (26.3, vanilla-plus profile)");
    expect(r.body.data.components).toBeUndefined();
    const [w] = (await worlds()).results;
    expect(w).toMatchObject({ name: "spring", status: "active" });
    expect(JSON.parse(w.profile_json).properties["level-seed"]).toBe("-42");
    expect(JSON.parse(w.lockfile_json).profile).toBe("vanilla-plus");
  });

  it("refuses bad names, taken names and unknown profiles", async () => {
    await addWorld("taken", "archived");
    const say = async (o: Record<string, string>) => (await postInteraction(slash("world new", o, M))).body.data.content as string;
    expect(await say({ name: "Bad Name", profile: "adventure" })).toMatch(/^World names must be/);
    expect(await say({ name: "a".repeat(31), profile: "adventure" })).toBe("World names can be up to 30 characters here.");
    expect(await say({ name: "taken", profile: "adventure" })).toBe('A world called "taken" already exists. Pick another name.');
    expect(await say({ name: "ok", profile: "nope" })).toBe("There's no profile called \"nope\" in this deploy.");
  });

  it("refuses while someone is hosting", async () => {
    await addWorld("w1");
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() });
    expect((await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M))).body.data.content).toContain(
      "is hosting right now",
    );
  });

  it("previews archiving the active world, then does it on Confirm", async () => {
    await addWorld("w1");
    await addSnapshot("w1", 1);
    await addSnapshot("w1", 2);
    const preview = await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M));
    expect(preview.body.data.content).toContain("This archives **w1** (rev 2");
    expect(preview.body.data.content).toContain("starts **spring** on 26.3 with the adventure profile");
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body).toMatchObject({ type: 7, data: { components: [] } });
    expect(done.body.data.content).toContain("Created **spring**");
    expect((await worlds()).results.map((w: any) => [w.name, w.status])).toEqual([
      ["w1", "archived"],
      ["spring", "active"],
    ]);
    // Archiving keeps only the last save.
    expect((await env.DB.prepare("SELECT rev FROM snapshots WHERE world_id = 'w1'").all()).results).toEqual([{ rev: 2 }]);
  });

  it("fits a 30-character name and a 32-character seed with colons in the button", async () => {
    await addWorld("w1");
    const name = "a".repeat(30);
    const seed = "s:".repeat(16);
    const preview = await postInteraction(slash("world new", { name, profile: "vanilla-plus", seed }, M));
    expect(confirmId(preview).length).toBeLessThanOrEqual(100);
    await postInteraction(button(confirmId(preview), M));
    const w = (await worlds()).results.find((x: any) => x.name === name);
    expect(JSON.parse(w.profile_json).properties["level-seed"]).toBe(seed);
  });

  it("refuses a stale Confirm and changes nothing", async () => {
    await addWorld("w1");
    const preview = await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M));
    await env.DB.prepare("UPDATE worlds SET status = 'archived' WHERE id = 'w1'").run();
    await addWorld("w2");
    const r = await postInteraction(button(confirmId(preview), M));
    expect(r.body.data.content).toBe("Things changed since the preview. Run the command again.");
    expect((await worlds()).results.map((w: any) => w.name)).not.toContain("spring");
  });

  it("refuses Confirm once someone starts hosting", async () => {
    await addWorld("w1");
    const preview = await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M));
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() });
    expect((await postInteraction(button(confirmId(preview), M))).body.data.content).toContain("is hosting right now");
    expect((await worlds()).results.map((w: any) => w.name)).toEqual(["w1"]);
  });

  it("Cancel changes nothing", async () => {
    await addWorld("w1");
    await postInteraction(slash("world new", { name: "spring", profile: "adventure" }, M));
    expect((await postInteraction(button("x", M))).body.data.content).toBe("Cancelled. Nothing changed.");
    expect((await worlds()).results.map((w: any) => w.name)).toEqual(["w1"]);
  });
});

describe("createWorld", () => {
  it("won't archive the world under a host who claims between the check and the write", async () => {
    await addWorld("w1");
    const b = (await bundledProfile("adventure"))!;
    // Someone runs `mc-host start` in the moment between createWorld's lease check and its batch.
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() });
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      createWorld({ DB: racing, BUCKET: env.BUCKET }, { name: "spring", profile: b.profile, lock: b.lock, replace: true, imported: false, now: Date.now() }),
    ).rejects.toMatchObject({ code: "lease_held" });
    expect((await worlds()).results.map((w: any) => [w.name, w.status])).toEqual([["w1", "active"]]);
    expect((await readLease(env.DB)).holder_id).toBe(ALEX);
  });
});
