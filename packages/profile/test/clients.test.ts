import { describe, expect, test } from "bun:test";
import { chooseLoader, createFabricMeta, serverLauncherUrl } from "../src/fabric";
import { createModrinthClient } from "../src/modrinth";
import { createMojangMeta } from "../src/mojang";
import { routeFetch, testHttp } from "./helpers";

const MR = "https://api.modrinth.com/v2";
const FABRIC = "https://meta.fabricmc.net/v2";

describe("modrinth client", () => {
  test("builds the version query for Fabric and one game version", async () => {
    const url = `${MR}/project/abc/version?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent('["26.3"]')}`;
    const { fetch, calls } = routeFetch({ [url]: [{ id: "v1" }] });
    const versions = await createModrinthClient(testHttp(fetch)).getVersions("abc", "26.3");
    expect(versions).toEqual([{ id: "v1" }] as never);
    expect(new Headers(calls[0]!.init?.headers).get("User-Agent")).toBe("test-agent");
  });

  test("getProject returns null for an unknown slug", async () => {
    const { fetch } = routeFetch({});
    expect(await createModrinthClient(testHttp(fetch)).getProject("nope")).toBeNull();
  });

  test("getVersions returns [] for an unknown project", async () => {
    const { fetch } = routeFetch({});
    expect(await createModrinthClient(testHttp(fetch)).getVersions("nope", "26.3")).toEqual([]);
  });

  test("searchSlug returns the first Fabric mod hit", async () => {
    const facets = encodeURIComponent(JSON.stringify([["categories:fabric"], ["project_type:mod"]]));
    const url = `${MR}/search?query=lithum&limit=1&facets=${facets}`;
    const { fetch } = routeFetch({ [url]: { hits: [{ slug: "lithium" }] } });
    expect(await createModrinthClient(testHttp(fetch)).searchSlug("lithum")).toBe("lithium");
  });
});

describe("fabric meta", () => {
  const routes = {
    [`${FABRIC}/versions/loader/26.3`]: [
      { loader: { version: "0.20.0-beta.1", stable: false } },
      { loader: { version: "0.19.5", stable: true } },
    ],
    [`${FABRIC}/versions/loader/9.9`]: [],
    [`${FABRIC}/versions/installer`]: [
      { version: "1.2.0-beta", stable: false },
      { version: "1.1.2", stable: true },
    ],
  };
  const meta = createFabricMeta(testHttp(routeFetch(routes).fetch));

  test("latest-stable skips unstable loaders", async () => {
    expect(await chooseLoader(meta, "26.3", "latest-stable")).toBe("0.19.5");
  });
  test("an exact loader must exist for that game version", async () => {
    expect(await chooseLoader(meta, "26.3", "0.19.5")).toBe("0.19.5");
    await expect(chooseLoader(meta, "26.3", "0.1.0")).rejects.toThrow(/Fabric loader 0\.1\.0 doesn't exist for Minecraft 26\.3/);
  });
  test("an unsupported game version gets a clear message", async () => {
    await expect(chooseLoader(meta, "9.9", "latest-stable")).rejects.toThrow(/Fabric doesn't support Minecraft 9\.9 yet/);
  });
  test("latest stable installer", async () => {
    expect(await meta.latestStableInstaller()).toBe("1.1.2");
  });
  test("server launcher url", () => {
    expect(serverLauncherUrl("26.3", "0.19.5", "1.1.2")).toBe(`${FABRIC}/versions/loader/26.3/0.19.5/1.1.2/server/jar`);
  });
});

describe("mojang meta", () => {
  const manifest = "https://mojang.test/manifest.json";
  const routes = {
    [manifest]: {
      versions: [
        { id: "26.4-snapshot-1", type: "snapshot", url: "https://mojang.test/snap.json" },
        { id: "26.3", type: "release", url: "https://mojang.test/26.3.json" },
      ],
    },
    "https://mojang.test/26.3.json": { javaVersion: { component: "java-runtime-epsilon", majorVersion: 25 } },
  };
  const mojang = createMojangMeta(testHttp(routeFetch(routes).fetch), manifest);

  test("reads the Java major version", async () => {
    expect(await mojang.javaMajor("26.3")).toBe(25);
  });
  test("rejects snapshots", async () => {
    await expect(mojang.javaMajor("26.4-snapshot-1")).rejects.toThrow(/is a snapshot, not a release/);
  });
  test("rejects unknown versions", async () => {
    await expect(mojang.javaMajor("99.1")).rejects.toThrow(/isn't in Mojang's version list/);
  });
});
