import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { postInteraction, slash } from "./discord";
import { addSnapshot, addWorld, lockEntry } from "./helpers";

const MODS = [
  lockEntry("lithium", "server"),
  lockEntry("waystones", "both"),
  lockEntry("voicechat", "both", { clientOptional: true }),
  lockEntry("sodium", "client-optional", { clientOptional: true }),
];

async function getPack(file: string) {
  const res = await app.request(`/modpack/${file}`, {}, env);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe("GET /modpack/:file", () => {
  beforeEach(() => addWorld("w1", "active", MODS, { description: "Test world" }));

  it("builds the .mrpack from the pinned lockfile", async () => {
    const { res, bytes } = await getPack("w1.mrpack");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-modrinth-modpack+zip");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="w1.mrpack"');
    const index = JSON.parse(strFromU8(unzipSync(bytes)["modrinth.index.json"]!));
    expect(index.name).toBe("w1");
    expect(index.summary).toBe("Test world");
    expect(index.files.map((f: { path: string }) => f.path)).toEqual([
      "mods/waystones-1.0.0.jar",
      "mods/voicechat-1.0.0.jar",
      "mods/sodium-1.0.0.jar",
    ]);
    expect(index.files[1].env.client).toBe("optional");
  });

  it("gives the same bytes every time", async () => {
    expect((await getPack("w1.mrpack")).bytes).toEqual((await getPack("w1.mrpack")).bytes);
  });

  it("is a 404 for an unknown world or a bad name", async () => {
    expect((await getPack("nope.mrpack")).res.status).toBe(404);
    expect((await getPack("w1.zip")).res.status).toBe(404);
  });
});

describe("/modpack", () => {
  it("links the active world's pack", async () => {
    await addWorld("w1", "active", MODS);
    const r = await postInteraction(slash("modpack"));
    // app.request() gives the Worker the origin http://localhost.
    expect(r.body.data.content).toContain("http://localhost/modpack/w1.mrpack");
    expect(r.body.data.content).toContain("Add Instance → Import");
  });

  it("says when every player needs it, and when it's optional", async () => {
    await addWorld("w1", "active", MODS);
    expect((await postInteraction(slash("modpack"))).body.data.content).toContain("Everyone needs it");
    await env.DB.prepare("DELETE FROM worlds").run();
    await addWorld("w2", "active", [lockEntry("lithium", "server")]);
    expect((await postInteraction(slash("modpack"))).body.data.content).toContain("optional on this world");
  });

  it("points to /world new without an active world", async () => {
    expect((await postInteraction(slash("modpack"))).body.data.content).toBe(
      "There's no active world. A maintainer can start one with `/world new`.",
    );
  });
});

describe("/world download", () => {
  it("links the latest snapshot for an hour", async () => {
    await addWorld("w1");
    await addSnapshot("w1", 1);
    await addSnapshot("w1", 2, { data: "the second save" });
    const r = await postInteraction(slash("world download"));
    const content: string = r.body.data.content;
    expect(content).toContain("**w1** rev 2");
    expect(content).toContain("The link works for 1 hour.");
    const url = /(http\S+)/.exec(content)![1]!;
    expect(await (await app.request(url, {}, env)).text()).toBe("the second save");
  });

  it("says when there's nothing saved yet", async () => {
    await addWorld("w1");
    expect((await postInteraction(slash("world download"))).body.data.content).toBe(
      "**w1** hasn't been saved yet, so there's nothing to download.",
    );
  });
});

describe("uploaded jars in the .mrpack", () => {
  // Review focus 3: a name with spaces goes in as-is.
  it("puts client jars under overrides/mods and leaves server-only ones out", async () => {
    const SHA_BOTH = "d".repeat(128);
    const SHA_SERVER = "e".repeat(128);
    await env.BUCKET.put(`jars/${SHA_BOTH}.jar`, new Uint8Array([1, 2, 3]));
    await env.BUCKET.put(`jars/${SHA_SERVER}.jar`, new Uint8Array([4]));
    const jar = (slug: string, side: "both" | "server", sha512: string, filename: string) =>
      lockEntry(slug, side, { projectId: "jar", source: "jar", sha512, filename, url: `jars/${sha512}` });
    await addWorld("w1", "active", [
      lockEntry("waystones", "both"),
      jar("dragonbond", "both", SHA_BOTH, "antiquetradingship-1.0.0 Fabric 26.3.jar"),
      jar("serverjar", "server", SHA_SERVER, "s.jar"),
    ]);
    const { res, bytes } = await getPack("w1.mrpack");
    expect(res.status).toBe(200);
    const zip = unzipSync(bytes);
    expect(zip["overrides/mods/antiquetradingship-1.0.0 Fabric 26.3.jar"]).toEqual(new Uint8Array([1, 2, 3]));
    expect(zip["overrides/mods/s.jar"]).toBeUndefined();
    const index = JSON.parse(strFromU8(zip["modrinth.index.json"]!));
    expect(index.files.map((f: { path: string }) => f.path)).toEqual(["mods/waystones-1.0.0.jar"]);
  });

  it("is a 500 when a pinned jar is missing from R2", async () => {
    const sha512 = "f".repeat(128);
    await addWorld("w1", "active", [lockEntry("gone", "both", { projectId: "jar", source: "jar", sha512, url: `jars/${sha512}` })]);
    expect((await getPack("w1.mrpack")).res.status).toBe(500);
  });
});
