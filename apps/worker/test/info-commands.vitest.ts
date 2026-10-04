import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimLease } from "../src/lease";
import { ALEX, postInteraction, slash } from "./discord";
import { addSnapshot, addUser, addWorld, hostSince, lockEntry } from "./helpers";

const content = async (path: string) => (await postInteraction(slash(path))).body.data.content as string;
const hostNow = () => hostSince(ALEX, "w1", 72 * 60_000);

beforeEach(() => addUser(ALEX, "Alex"));

describe("/status", () => {
  it("shows the host, address and last save", async () => {
    await addWorld("w1");
    await addSnapshot("w1", 4, { at: Date.now() - 3 * 3_600_000 });
    await hostNow();
    const s = await content("status");
    expect(s).toContain(`🟢 <@${ALEX}> is hosting **w1** (26.3) at \`100.64.0.3:25565\`.`);
    expect(s).toContain("Hosting for 1h 12m.");
    expect(s).toContain(`Last saved 3h ago by <@${ALEX}> (rev 4).`);
  });

  it("says nobody is hosting, and how to start", async () => {
    await addWorld("w1");
    const s = await content("status");
    expect(s).toContain("Nobody is hosting **w1** (26.3) right now.");
    expect(s).toContain("It hasn't been saved yet.");
    expect(s).toContain("`mc-host start`");
  });

  it("treats an expired lease as nobody hosting", async () => {
    await addWorld("w1");
    await claimLease(env.DB, { userId: ALEX, hostAddress: "100.64.0.3", worldId: "w1", now: Date.now() - 60 * 60_000 });
    expect(await content("status")).toContain("Nobody is hosting");
  });

  it("points to /world new without a world", async () => {
    expect(await content("status")).toBe("There's no active world. A maintainer can start one with `/world new`.");
  });
});

describe("/join", () => {
  it("walks through Prism, the modpack and the address", async () => {
    await addWorld("w1", "active", [lockEntry("waystones", "both")]);
    await hostNow();
    const s = await content("join");
    expect(s).toContain("https://prismlauncher.org");
    expect(s).toContain("http://localhost/modpack/w1.mrpack");
    expect(s).toContain("`100.64.0.3:25565`");
    expect(s).toContain("Ask a maintainer to get you onto the tailnet");
  });

  it("says vanilla clients work on a vanilla-compatible world, and when nobody hosts", async () => {
    await addWorld("w1", "active", [lockEntry("lithium", "server")]);
    const s = await content("join");
    expect(s).toContain("Any vanilla 26.3 client can join");
    expect(s).toContain("Nobody is hosting right now");
  });
});

describe("/mod list", () => {
  it("groups mods by side and lists the waiting ones", async () => {
    await addWorld(
      "w1",
      "active",
      [
        lockEntry("lithium", "server"),
        lockEntry("waystones", "both", { versionNumber: "2.1.0" }),
        lockEntry("balm", "both", { auto: true }),
        lockEntry("sodium", "client-optional", { clientOptional: true }),
      ],
      { waiting: ["lootr"] },
    );
    const s = await content("mod list");
    expect(s).toContain("**w1** (26.3, Fabric 0.19.5)");
    expect(s).toMatch(/__Everyone needs these__\n- waystones 2\.1\.0\n- balm 1\.0\.0 \(dependency\)/);
    expect(s).toMatch(/__Server only__\n- lithium 1\.0\.0/);
    expect(s).toMatch(/__Optional for players__\n- sodium 1\.0\.0/);
    expect(s).toContain("__Waiting for a 26.3 release__\nlootr");
  });

  it("stays under Discord's limit with a huge profile", async () => {
    await addWorld("w1", "active", Array.from({ length: 80 }, (_, i) => lockEntry(`some-long-mod-name-${i}`, "both")));
    const s = await content("mod list");
    expect(s.length).toBeLessThanOrEqual(2000);
    expect(s).toContain("cut to fit");
  });

  it("tags uploaded jars", async () => {
    await addWorld("w1", "active", [lockEntry("dragonbond", "both", { source: "jar", versionNumber: "1.1.1" })]);
    expect(await content("mod list")).toContain("- dragonbond 1.1.1 (uploaded)");
  });

  it("lists a bundled profile's mods, with or without an active world", async () => {
    const list = async (profile: string) => (await postInteraction(slash("mod list", { profile }))).body.data.content as string;
    const s = await list("adventure");
    expect(s).toContain("**adventure** profile (26.3, Fabric 0.19.5)");
    expect(s).toContain("- badoptimizations 2.4.1");
    await addWorld("w1", "active", [lockEntry("only-in-the-world", "server")]);
    expect(await list("adventure")).not.toContain("only-in-the-world");
  });

  it("names a profile that isn't in this deploy", async () => {
    const s = (await postInteraction(slash("mod list", { profile: "gone" }))).body.data.content;
    expect(s).toBe('There\'s no profile called "gone" in this deploy. Pick one from the list.');
  });
});
