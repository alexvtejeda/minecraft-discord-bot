import { describe, expect, test } from "bun:test";
import { parseLock, serializeLock } from "../src/lockfile";
import { checkAvailability, resolveProfile, type ResolveDeps } from "../src/resolve";
import { dep, FakeJars, FakeModrinth, fakeFabric, fakeMojang, jarInfo, makeProfile } from "./fakes";

function deps(mr: FakeModrinth): ResolveDeps {
  return { modrinth: mr, fabric: fakeFabric, mojang: fakeMojang };
}

describe("resolveProfile", () => {
  test("pins loader, installer, java and each file with its side", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium", [{}], { client: "optional", server: "optional" });
    mr.add("sodium", [{}], { client: "required", server: "unsupported" });
    const profile = makeProfile({
      mods: [
        { modrinth: "sodium", side: "client-optional" },
        { modrinth: "lithium", side: "server" },
      ],
    });
    const { lock, warnings } = await resolveProfile(profile, deps(mr));
    expect(lock.fabricLoader).toBe("0.19.5");
    expect(lock.fabricInstaller).toBe("1.1.2");
    expect(lock.javaMajor).toBe(25);
    expect(lock.profileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(warnings).toEqual([]);
    expect(lock.files.map((f) => [f.slug, f.side, f.auto])).toEqual([
      ["lithium", "server", false],
      ["sodium", "client-optional", false],
    ]);
    expect(lock.files[1]!.clientOptional).toBe(true);
    expect(lock.files[0]).toMatchObject({
      projectId: "LITHIUM",
      versionId: "lithium-v1",
      filename: "LITHIUM-lithium-v1.jar",
      sha512: "sha512-lithium-v1",
      prerelease: false,
    });
  });

  test("a prerelease-only mod resolves with a warning and a flag", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium", [{ version_type: "beta", version_number: "0.9-beta" }]);
    const { lock, warnings } = await resolveProfile(makeProfile(), deps(mr));
    expect(lock.files[0]!.prerelease).toBe(true);
    expect(warnings[0]).toMatch(/lithium: only a beta build exists for Minecraft 26\.3, using 0\.9-beta/);
  });

  test("an alpha-only mod gets grammatical wording", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium", [{ version_type: "alpha", version_number: "0.1-alpha" }]);
    const { warnings } = await resolveProfile(makeProfile(), deps(mr));
    expect(warnings[0]).toBe("lithium: only an alpha build exists for Minecraft 26.3, using 0.1-alpha.");
  });

  test("unknown slug suggests the closest match", async () => {
    const mr = new FakeModrinth();
    mr.searches.set("lithum", "lithium");
    const profile = makeProfile({ mods: [{ modrinth: "lithum", side: "server" }] });
    await expect(resolveProfile(profile, deps(mr))).rejects.toThrow('No mod called "lithum" on Modrinth. Did you mean "lithium"?');
  });

  test("a mod with no build for the version suggests waiting", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium", [{ game_versions: ["26.2"] }]);
    await expect(resolveProfile(makeProfile(), deps(mr))).rejects.toThrow(/has no Fabric build for Minecraft 26\.3 yet\. Move "lithium" to "waiting"/);
  });

  test("honors a version pin", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium", [
      { version_number: "new", date_published: "2026-09-20T00:00:00Z" },
      { version_number: "old", date_published: "2026-09-01T00:00:00Z" },
    ]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "lithium", side: "server", version: "old" }] }), deps(mr));
    expect(lock.files[0]!.versionNumber).toBe("old");
  });

  test("pulls in required dependencies and marks them auto", async () => {
    const mr = new FakeModrinth();
    const balm = mr.add("balm");
    mr.add("waystones", [{ dependencies: [dep(balm), dep("OPTIONAL-THING", "optional")] }]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "waystones", side: "both" }] }), deps(mr));
    expect(lock.files.map((f) => [f.slug, f.side, f.auto])).toEqual([
      ["balm", "both", true],
      ["waystones", "both", false],
    ]);
  });

  // Review focus 1
  test("a library listed as server becomes required on the client when a both mod needs it", async () => {
    const mr = new FakeModrinth();
    const api = mr.add("fabric-api", [{}], { client: "optional", server: "optional" });
    mr.add("waystones", [{ dependencies: [dep(api)] }]);
    const profile = makeProfile({
      mods: [
        { modrinth: "fabric-api", side: "server" },
        { modrinth: "waystones", side: "both" },
      ],
    });
    const { lock } = await resolveProfile(profile, deps(mr));
    const api_ = lock.files.find((f) => f.slug === "fabric-api")!;
    expect(api_).toMatchObject({ side: "both", clientOptional: false, auto: false });
  });

  test("a server library needed by a client-optional mod becomes both, optional on the client", async () => {
    const mr = new FakeModrinth();
    const api = mr.add("fabric-api", [{}], { client: "optional", server: "optional" });
    mr.add("modmenu", [{ dependencies: [dep(api)] }], { client: "required", server: "unsupported" });
    const profile = makeProfile({
      mods: [
        { modrinth: "fabric-api", side: "server" },
        { modrinth: "modmenu", side: "client-optional" },
      ],
    });
    const { lock } = await resolveProfile(profile, deps(mr));
    expect(lock.files.find((f) => f.slug === "fabric-api")).toMatchObject({ side: "both", clientOptional: true });
  });

  // Review focus 2
  test("a server-only dependency of a both mod is never sent to clients", async () => {
    const mr = new FakeModrinth();
    const lib = mr.add("server-lib", [{}], { client: "unsupported", server: "required" });
    mr.add("waystones", [{ dependencies: [dep(lib)] }]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "waystones", side: "both" }] }), deps(mr));
    expect(lock.files.find((f) => f.slug === "server-lib")).toMatchObject({ side: "server", auto: true });
  });

  test("a dependency pinned by version id is fetched directly", async () => {
    const mr = new FakeModrinth();
    const lib = mr.add("lib", [{ id: "lib-exact", game_versions: ["26.3-pre-1"] }]);
    mr.add("waystones", [{ dependencies: [{ project_id: lib, version_id: "lib-exact", file_name: null, dependency_type: "required" }] }]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "waystones", side: "both" }] }), deps(mr));
    expect(lock.files.find((f) => f.slug === "lib")!.versionId).toBe("lib-exact");
  });

  test("a dependency cycle terminates", async () => {
    const mr = new FakeModrinth();
    mr.add("a", [{ dependencies: [dep("B")] }]);
    mr.add("b", [{ dependencies: [dep("A")] }]);
    const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "a", side: "both" }] }), deps(mr));
    expect(lock.files.map((f) => f.slug)).toEqual(["a", "b"]);
  });

  test("incompatible mods fail and name both", async () => {
    const mr = new FakeModrinth();
    const b = mr.add("optifabric");
    mr.add("sodium", [{ dependencies: [dep(b, "incompatible")] }]);
    const profile = makeProfile({
      mods: [
        { modrinth: "sodium", side: "client-optional" },
        { modrinth: "optifabric", side: "client-optional" },
      ],
    });
    await expect(resolveProfile(profile, deps(mr))).rejects.toThrow(/sodium and optifabric don't work together/);
  });

  test("an incompatible mod that is not in the profile is fine", async () => {
    const mr = new FakeModrinth();
    mr.add("sodium", [{ dependencies: [dep("NOT-HERE", "incompatible")] }]);
    await expect(resolveProfile(makeProfile({ mods: [{ modrinth: "sodium", side: "client-optional" }] }), deps(mr))).resolves.toBeDefined();
  });

  test("a dependency that is not on Modrinth fails with advice", async () => {
    const mr = new FakeModrinth();
    mr.add("waystones", [{ dependencies: [{ project_id: null, version_id: null, file_name: "secret-lib.jar", dependency_type: "required" }] }]);
    await expect(resolveProfile(makeProfile({ mods: [{ modrinth: "waystones", side: "both" }] }), deps(mr))).rejects.toThrow(
      /waystones needs "secret-lib\.jar", which isn't on Modrinth/,
    );
  });

  test("reports waiting mods and suggests a side for ready ones", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium");
    mr.add("lootr", [{}], { client: "required", server: "required" });
    mr.add("carry-on", [{ game_versions: ["26.2"] }]);
    const { waiting, warnings } = await resolveProfile(makeProfile({ waiting: ["lootr", "carry-on", "ghost"] }), deps(mr));
    expect(waiting).toEqual([
      { slug: "lootr", ready: true, suggestedSide: "both" },
      { slug: "carry-on", ready: false },
      { slug: "ghost", ready: false },
    ]);
    expect(warnings).toContain('Waiting mod "ghost" isn\'t on Modrinth. Check the spelling.');
  });

  test("a waiting mod stays waiting while a required dependency has no build, and names it", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium");
    mr.add("fabric-api");
    mr.add("qsl", [{ game_versions: ["1.20.1"] }]);
    mr.add("modmenu", [{ game_versions: ["1.20.1"] }]);
    mr.add("more-mobs", [{ dependencies: [dep("FABRIC-API"), dep("QSL"), dep("MODMENU", "optional")] }]);
    mr.add("needs-jar", [{ dependencies: [{ project_id: null, version_id: null, file_name: "secret.jar", dependency_type: "required" }] }]);
    mr.add("pinned", [{ dependencies: [{ project_id: null, version_id: "qsl-v1", file_name: null, dependency_type: "required" }] }]);
    const { waiting } = await resolveProfile(makeProfile({ waiting: ["more-mobs", "needs-jar", "pinned"] }), deps(mr));
    expect(waiting).toEqual([
      { slug: "more-mobs", ready: false, blockedBy: ["qsl"] },
      { slug: "needs-jar", ready: false, blockedBy: ["secret.jar"] },
      { slug: "pinned", ready: false, blockedBy: ["qsl"] },
    ]);
  });

  test("the lockfile is deterministic and round-trips", async () => {
    const mr = new FakeModrinth();
    mr.add("zeta");
    mr.add("alpha");
    const profile = makeProfile({ mods: [{ modrinth: "zeta", side: "server" }, { modrinth: "alpha", side: "server" }] });
    const a = serializeLock((await resolveProfile(profile, deps(mr))).lock);
    const b = serializeLock((await resolveProfile(profile, deps(mr))).lock);
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    expect(parseLock(a, "x.lock.json").files.map((f) => f.slug)).toEqual(["alpha", "zeta"]);
  });
});

test("parseLock rejects garbage with advice", () => {
  expect(() => parseLock("{", "x.lock.json")).toThrow(/x\.lock\.json isn't valid JSON/);
  expect(() => parseLock('{"lockfileVersion":2,"files":[]}', "x.lock.json")).toThrow(/Run "mc-host profile resolve" again/);
});

test("checkAvailability reports every mod and waiting mod for another version", async () => {
  const mr = new FakeModrinth();
  mr.add("lithium", [{ game_versions: ["26.3", "26.2"] }]);
  mr.add("lootr", [{ game_versions: ["26.2"] }]);
  const report = await checkAvailability(makeProfile({ waiting: ["lootr", "ghost"] }), "26.2", mr);
  expect(report).toEqual([
    { slug: "lithium", available: true, waiting: false },
    { slug: "lootr", available: true, waiting: true },
    { slug: "ghost", available: false, waiting: true },
  ]);
});

// Final review I3
test("a client-only library required by a both mod is locked as required on the client", async () => {
  const mr = new FakeModrinth();
  const lib = mr.add("client-lib", [{}], { client: "required", server: "unsupported" });
  mr.add("waystones", [{ dependencies: [dep(lib)] }]);
  const { lock } = await resolveProfile(makeProfile({ mods: [{ modrinth: "waystones", side: "both" }] }), deps(mr));
  expect(lock.files.find((f) => f.slug === "client-lib")).toMatchObject({ side: "client-optional", clientOptional: false, auto: true });
});

describe("uploaded jars", () => {
  const SHA = "b".repeat(128);
  const entry = { jar: "dragonbond", filename: "the deeper end.jar", sha512: SHA, side: "both" };

  test("become lock entries with source jar, sorted with the rest", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium");
    const jars = new FakeJars();
    jars.add(jarInfo(SHA));
    const profile = makeProfile({ mods: [{ modrinth: "lithium", side: "server" }, entry] });
    const { lock } = await resolveProfile(profile, { ...deps(mr), jars });
    expect(lock.files.map((f) => f.slug)).toEqual(["dragonbond", "lithium"]);
    expect(lock.files[0]).toEqual({
      slug: "dragonbond",
      projectId: "jar",
      versionId: SHA.slice(0, 12),
      versionNumber: "1.1.1",
      filename: "the deeper end.jar",
      url: `jars/${SHA}`,
      sha1: "1".repeat(40),
      sha512: SHA,
      size: 1234,
      side: "both",
      clientOptional: false,
      auto: false,
      prerelease: false,
      source: "jar",
    });
    expect(parseLock(serializeLock(lock), "x").files[0]!.source).toBe("jar");
  });

  test("fail when the jar was never uploaded", async () => {
    const profile = makeProfile({ mods: [entry] });
    await expect(resolveProfile(profile, { ...deps(new FakeModrinth()), jars: new FakeJars() })).rejects.toThrow(
      `dragonbond: sha512 ${SHA.slice(0, 12)} isn't uploaded. Run "mc-host admin jar add test the deeper end.jar".`,
    );
  });

  test("fail without a jar client", async () => {
    await expect(resolveProfile(makeProfile({ mods: [entry] }), deps(new FakeModrinth()))).rejects.toThrow(/MC_WORKER_URL and MC_ADMIN_SECRET/);
  });

  test("fail when the jar is for another Minecraft version", async () => {
    const jars = new FakeJars();
    jars.add(jarInfo(SHA, { minecraftRange: "=26.1.2" }));
    await expect(resolveProfile(makeProfile({ mods: [entry] }), { ...deps(new FakeModrinth()), jars })).rejects.toThrow(
      "dragonbond is built for Minecraft =26.1.2, but test is on 26.3. Remove it from the profile.",
    );
  });

  test("a jar can't share a name with a Modrinth file", async () => {
    const mr = new FakeModrinth();
    mr.add("lithium");
    const jars = new FakeJars();
    jars.add(jarInfo(SHA));
    const profile = makeProfile({ mods: [{ modrinth: "lithium", side: "server" }, { ...entry, jar: "x" }] });
    // Same name via a dependency: lithium pulls in "x".
    mr.add("x");
    mr.versions.get("LITHIUM")![0]!.dependencies = [dep("X")];
    await expect(resolveProfile(profile, { ...deps(mr), jars })).rejects.toThrow(/"x" is also the name of a mod from Modrinth/);
  });

  test("warn when the jar's mod ID matches a Modrinth slug", async () => {
    const mr = new FakeModrinth();
    mr.add("dragonbond-mr");
    const jars = new FakeJars();
    jars.add(jarInfo(SHA, { modId: "dragonbond-mr" }));
    const profile = makeProfile({ mods: [{ modrinth: "dragonbond-mr", side: "both" }, entry] });
    const { warnings } = await resolveProfile(profile, { ...deps(mr), jars });
    expect(warnings).toContain('dragonbond may be the same mod as Modrinth\'s "dragonbond-mr". Remove one of them if the server fails to start.');
  });
});
