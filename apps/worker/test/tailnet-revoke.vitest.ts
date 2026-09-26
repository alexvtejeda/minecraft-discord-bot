import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALEX, button, postInteraction, SAM, slash } from "./discord";
import { addWorld, call, hostSince } from "./helpers";
import { fakeTailscale } from "./tailscale";

afterEach(() => vi.restoreAllMocks());

const M = { maintainer: true, user: SAM };
const confirmId = (r: { body: any }) => r.body.data.components[0].components[0].custom_id as string;

/** ALEX goes through /setup host and the installer, reporting the given devices. */
async function enrolled(nodeIds: string[]): Promise<string> {
  fakeTailscale();
  let token = "";
  for (const nodeId of nodeIds) {
    const r = await postInteraction(slash("setup", { host: true }, { username: "alex" }));
    const code = /\/s\/([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(r.body.data.content)![1]!;
    token = (await call("POST", "/enroll", { body: { code, join: true } })).body.token;
    await call("POST", "/enroll/device", { body: { code, nodeId } });
  }
  vi.restoreAllMocks();
  return token;
}
const count = (table: string) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE discord_id = ?`).bind(ALEX).first<number>("n");

describe("/tailnet revoke", () => {
  it("previews the devices it will remove", async () => {
    await enrolled(["nOne", "nTwo"]);
    const r = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    expect(r.body.data.content).toContain(`Remove <@${ALEX}> from the Minecraft network?`);
    expect(r.body.data.content).toContain("their 2 devices (`mc-alex`, `mc-alex`)");
    expect(confirmId(r)).toBe(`c:revoke:${ALEX}`);
  });

  it("Confirm deletes the devices, blocks the token and refuses /setup", async () => {
    const token = await enrolled(["nOne"]);
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    const calls = fakeTailscale();
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain(`Removed <@${ALEX}> from the Minecraft network`);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://api.tailscale.com/api/v2/device/nOne"]);
    expect(await count("devices")).toBe(0);
    expect(await count("enrollments")).toBe(0);
    expect((await call("GET", "/agent/manifest", { token })).status).toBe(401);
    const again = await postInteraction(slash("setup", {}, { username: "alex" }));
    expect(again.body.data.content).toContain("You've been removed from the Minecraft network");
  });

  it("counts a device Tailscale already forgot as removed", async () => {
    await enrolled(["nGone"]);
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    fakeTailscale({ deleteStatus: { nGone: 404 } });
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain("Removed");
    expect(await count("devices")).toBe(0);
  });

  it("still blocks them when Tailscale fails, and says to run it again", async () => {
    const token = await enrolled(["nStuck"]);
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    fakeTailscale({ deleteStatus: { nStuck: 500 } });
    const done = await postInteraction(button(confirmId(preview), M));
    expect(done.body.data.content).toContain("couldn't reach Tailscale to remove `mc-alex`");
    expect(done.body.data.content).toContain("Run `/tailnet revoke` again");
    expect(await count("devices")).toBe(1);
    expect((await call("GET", "/agent/manifest", { token })).status).toBe(401);
  });

  it("blocks someone who never ran /setup", async () => {
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    expect(preview.body.data.content).toContain("no devices on record");
    fakeTailscale();
    await postInteraction(button(confirmId(preview), M));
    const setup = await postInteraction(slash("setup", {}, { username: "alex" }));
    expect(setup.body.data.content).toContain("You've been removed from the Minecraft network");
  });

  it("warns when they're hosting right now", async () => {
    await enrolled(["nOne"]);
    await addWorld("w1");
    await hostSince(ALEX, "w1", 60_000);
    const r = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    expect(r.body.data.content).toContain("They're hosting right now");
  });

  it("needs the maintainer role", async () => {
    const r = await postInteraction(slash("tailnet revoke", { user: ALEX }, { user: SAM }));
    expect(r.body.data.content).toBe("That needs the MC Maintainer role.");
  });

  it("a fresh token lets them back in", async () => {
    await enrolled(["nOne"]);
    const preview = await postInteraction(slash("tailnet revoke", { user: ALEX }, M));
    fakeTailscale();
    await postInteraction(button(confirmId(preview), M));
    await call("POST", "/admin/tokens", { admin: true, body: { discordId: ALEX, name: "Alex" } });
    const setup = await postInteraction(slash("setup", {}, { username: "alex" }));
    expect(setup.body.data.content).toContain("irm ");
  });
});
