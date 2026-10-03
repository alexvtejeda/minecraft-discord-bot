import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postInteraction, slash } from "./discord";
import { addWorld, fabricJar } from "./helpers";

const ATT_URL = "https://cdn.discordapp.com/attachments/1/2/deeper_end.jar";

function upload(o: { side?: string; name?: string; filename?: string; size?: number; maintainer?: boolean } = {}) {
  const p: any = slash("mod upload", { side: o.side ?? "both", ...(o.name ? { name: o.name } : {}) }, { maintainer: o.maintainer ?? true });
  p.data.options[0].options.push({ name: "jar", type: 11, value: "att1" });
  p.data.resolved = { attachments: { att1: { id: "att1", url: ATT_URL, filename: o.filename ?? "deeper_end.jar", size: o.size ?? 100 } } };
  return p;
}

/** Serve the attachment, and record what's sent to Discord's webhook. */
function fakeDiscord(jar: Uint8Array | null) {
  const edits: { url: string; body: any }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as Request | string, init);
    if (req.url === ATT_URL) return jar ? new Response(jar) : new Response("gone", { status: 404 });
    edits.push({ url: req.url, body: await req.json() });
    return Response.json({ id: "1" });
  });
  return edits;
}

afterEach(() => vi.restoreAllMocks());

describe("/mod upload", () => {
  it("defers, stores the jar, and edits in the profile line with hints", async () => {
    await addWorld("w1");
    const edits = fakeDiscord(fabricJar());
    const r = await postInteraction(upload());
    expect(r.body).toEqual({ type: 5, data: { flags: 64 } });
    expect(edits).toHaveLength(1);
    expect(edits[0]!.url).toMatch(/\/webhooks\/200000000000000001\/interaction-token-\d+\/messages\/@original$/);
    const text: string = edits[0]!.body.content;
    expect(text).toContain("Stored deeper_end.jar (dragonbond 1.1.1).");
    expect(text).toMatch(/\{"jar":"dragonbond","filename":"deeper_end.jar","sha512":"[0-9a-f]{128}","side":"both"\}/);
    expect(text).toContain('Needs "citadel"');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jars").first("n")).toBe(1);
  });

  it("uses the name option and the server side", async () => {
    await addWorld("w1");
    const edits = fakeDiscord(fabricJar());
    await postInteraction(upload({ name: "deeper-end", side: "server" }));
    expect(edits[0]!.body.content).toContain('{"jar":"deeper-end",');
    expect(edits[0]!.body.content).toContain('"side":"server"}');
  });

  it("edits in the problem for a NeoForge jar", async () => {
    await addWorld("w1");
    const { zipSync } = await import("fflate");
    const edits = fakeDiscord(zipSync({ "META-INF/neoforge.mods.toml": new Uint8Array() }));
    await postInteraction(upload({ filename: "x-neoforge.jar" }));
    expect(edits[0]!.body.content).toBe("x-neoforge.jar is a NeoForge build. Get the Fabric build of this mod instead.");
  });

  it("answers right away for a non-jar, a huge file, no world, or a non-maintainer", async () => {
    fakeDiscord(fabricJar());
    expect((await postInteraction(upload())).body.data.content).toContain("mc-host admin jar add");
    await addWorld("w1");
    expect((await postInteraction(upload({ filename: "x.zip" }))).body.data.content).toBe("x.zip isn't a .jar file.");
    expect((await postInteraction(upload({ size: 40 * 1024 * 1024 }))).body.data.content).toContain("over 32 MB");
    expect((await postInteraction(upload({ maintainer: false }))).body.data.content).toBe("That needs the MC Maintainer role.");
  });

  it("edits in a download failure", async () => {
    await addWorld("w1");
    const edits = fakeDiscord(null);
    await postInteraction(upload());
    expect(edits[0]!.body.content).toBe("Couldn't download deeper_end.jar from Discord (HTTP 404). Try again.");
  });
});
