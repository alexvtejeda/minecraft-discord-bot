import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CODE_MS, newCode, normalizeCode, pendingEnrollment } from "../src/enroll";
import { revokeUser } from "../src/users";
import { ALEX, postInteraction, slash } from "./discord";

const CODE = /\/s\/([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/;
const row = () => env.DB.prepare("SELECT * FROM enrollments WHERE discord_id = ?").bind(ALEX).first<any>();

async function runSetup(sub: "play" | "host" | "help" = "play") {
  const r = await postInteraction(slash(`setup ${sub}`, {}, { username: "alex.v" }));
  const content: string = r.body.data.content;
  return { content, code: CODE.exec(content)?.[1] ?? null, flags: r.body.data.flags };
}

describe("codes", () => {
  it("are 8 characters from the unambiguous alphabet, shown as XXXX-XXXX", () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });

  it("are read back however they were pasted", () => {
    expect(normalizeCode("k7qx-p2md")).toBe("K7QX-P2MD");
    expect(normalizeCode(" K7QXP2MD ")).toBe("K7QX-P2MD");
    expect(normalizeCode("k7qx p2md")).toBe("K7QX-P2MD");
  });

  it("reject anything that can't be a code", () => {
    expect(normalizeCode("K7QX-P2M")).toBeNull();
    expect(normalizeCode("K7QX-P2M0")).toBeNull(); // 0 isn't in the alphabet
    expect(normalizeCode("")).toBeNull();
  });
});

describe("/setup", () => {
  it("replies privately with a personal one-liner and stores only the code's hash", async () => {
    const { content, code, flags } = await runSetup();
    expect(flags).toBe(64); // ephemeral
    expect(content).toContain(`irm http://localhost/s/${code} | iex`);
    expect(content).toContain("works once and expires in 15 minutes");
    const r = await row();
    expect(r).toMatchObject({ name: "alex.v", mode: "play", used_at: null });
    expect(r.code_hash).not.toContain(code);
    expect(r.expires_at - r.created_at).toBe(CODE_MS);
  });

  it("/setup host makes a hosting code", async () => {
    const { content } = await runSetup("host");
    expect(content).toContain("play and host");
    expect(content).toContain("`/setup help`");
    expect((await row()).mode).toBe("host");
  });

  it("/setup play points at /setup host and /setup help", async () => {
    const { content } = await runSetup("play");
    expect(content).toContain("`/setup host`");
    expect(content).toContain("`/setup help`");
  });

  it("a second /setup replaces the first code", async () => {
    const first = (await runSetup()).code!;
    const second = (await runSetup()).code!;
    expect(await pendingEnrollment(env.DB, first, Date.now())).toBeNull();
    expect(await pendingEnrollment(env.DB, second, Date.now())).not.toBeNull();
  });

  it("/setup help explains hosting and makes no code", async () => {
    const { content, code, flags } = await runSetup("help");
    expect(flags).toBe(64);
    expect(code).toBeNull();
    for (const step of ["**Host Minecraft**", "`mc-host start`", "Ctrl+C", "Hosting has stopped", "`/join`", "`/modpack`", "`/setup host`", "Web Shield"]) {
      expect(content).toContain(step);
    }
    expect(await row()).toBeNull();
  });

  it("refuses someone who was removed", async () => {
    await revokeUser(env.DB, ALEX, Date.now());
    const { content, code } = await runSetup();
    expect(content).toBe("You've been removed from the Minecraft network. Ask a maintainer to let you back in.");
    expect(code).toBeNull();
    expect(await row()).toBeNull();
  });
});
