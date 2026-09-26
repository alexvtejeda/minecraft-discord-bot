import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProfile, profileHash, serializeLock, type Fetch } from "@mc/profile";
import { runAdmin } from "../src/admin";
import type { Deps } from "../src/commands";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function profilesDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mc-admin-profiles-"));
  const raw = {
    name: "test",
    description: "t",
    minecraft: "26.3",
    loader: { fabric: "latest-stable" },
    memory: { min: "2G", max: "4G" },
    mods: [{ modrinth: "lithium", side: "server" }],
  };
  writeFileSync(join(dir, "test.json"), JSON.stringify(raw));
  const profile = parseProfile(raw, "test.json");
  const lock = {
    lockfileVersion: 1 as const,
    profile: "test",
    profileHash: await profileHash(profile),
    minecraft: "26.3",
    javaMajor: 25,
    fabricLoader: "0.19.5",
    fabricInstaller: "1.1.2",
    files: [],
  };
  writeFileSync(join(dir, "test.lock.json"), serializeLock(lock));
  return dir;
}

function worker() {
  const seen: { method: string; url: string; body?: any }[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url, body });
    if (url.endsWith("/admin/worlds")) return json({ id: "w1", name: body.name }, 201);
    if (url.endsWith("/import-url")) {
      return json({ rev: 1, key: "worlds/w1/1-x.zip", url: "https://r2.test/put", headers: { "x-amz-checksum-sha256": "x" } });
    }
    if (url === "https://r2.test/put") return new Response(null, { status: 200 });
    if (url.endsWith("/import-commit")) return json({ rev: 1 });
    if (url.endsWith("/admin/tokens")) return json({ token: "t".repeat(43) }, 201);
    if (url.endsWith("/admin/lease/release")) {
      return json({ released: { name: "Alex", hostAddress: "100.64.0.3", claimedAt: 0, expiresAt: 0 } });
    }
    if (url.endsWith("/admin/status")) {
      return json({
        world: { id: "w1", name: "test-1", minecraft: "26.3", latestRev: 4, latestAt: null, pregenDone: true },
        lease: null,
        users: [{ discordId: "1", name: "Alex", revoked: false }, { discordId: "2", name: "Sam", revoked: true }],
      });
    }
    return json({ error: "not_found", message: "nope" }, 404);
  };
  return { fetch, seen };
}

function deps(fetch: Fetch, logs: string[], env: Record<string, string> = { MC_WORKER_URL: "https://w.test", MC_ADMIN_SECRET: "sec" }): Deps {
  return {
    fetch,
    cacheDir: mkdtempSync(join(tmpdir(), "mc-admin-cache-")),
    configDir: mkdtempSync(join(tmpdir(), "mc-admin-cfg-")),
    log: (l) => logs.push(l),
    ask: async () => "",
    env,
    now: () => new Date(2026, 8, 26, 12).getTime(),
  };
}

test("world create sends the profile and its lockfile, with a dated default name", async () => {
  const { fetch, seen } = worker();
  const logs: string[] = [];
  await runAdmin({ kind: "admin-world-create", profile: "test", replace: false, profilesDir: await profilesDir() }, deps(fetch, logs));
  expect(seen[0]!.url).toBe("https://w.test/admin/worlds");
  expect(seen[0]!.body).toMatchObject({ name: "test-2026-09-26", replace: false, imported: false, profile: { name: "test" }, lockfile: { profile: "test" } });
  expect(logs[0]).toContain("Created test-2026-09-26");
});

test("world create --import uploads the server folder as rev 1", async () => {
  const { fetch, seen } = worker();
  const srv = mkdtempSync(join(tmpdir(), "mc-import-"));
  mkdirSync(join(srv, "world"));
  writeFileSync(join(srv, "world", "level.dat"), "old world");
  const logs: string[] = [];
  await runAdmin({ kind: "admin-world-create", profile: "test", replace: true, importDir: srv, profilesDir: await profilesDir() }, deps(fetch, logs));
  expect(seen.map((s) => `${s.method} ${s.url.replace("https://w.test", "")}`)).toEqual([
    "POST /admin/worlds",
    "POST /admin/worlds/w1/import-url",
    "PUT https://r2.test/put",
    "POST /admin/worlds/w1/import-commit",
  ]);
  expect(seen[0]!.body).toMatchObject({ replace: true, imported: true });
  expect(seen[3]!.body).toEqual({ key: "worlds/w1/1-x.zip", size: seen[1]!.body.size, sha256: seen[1]!.body.sha256 });
  expect(logs.at(-1)).toContain("as rev 1");
});

test("--import pointed at the world folder itself fails before anything is created", async () => {
  const { fetch, seen } = worker();
  const worldDir = mkdtempSync(join(tmpdir(), "mc-worlddir-"));
  writeFileSync(join(worldDir, "level.dat"), "x");
  await expect(
    runAdmin({ kind: "admin-world-create", profile: "test", replace: false, importDir: worldDir, profilesDir: await profilesDir() }, deps(fetch, [])),
  ).rejects.toThrow("doesn't look like a server folder");
  expect(seen).toEqual([]);
});

test("token mint, lease release and status print what happened", async () => {
  const { fetch } = worker();
  const logs: string[] = [];
  const d = deps(fetch, logs);
  await runAdmin({ kind: "admin-token-mint", discordId: "123456789012345678", name: "Sam" }, d);
  await runAdmin({ kind: "admin-lease-release" }, d);
  await runAdmin({ kind: "admin-status" }, d);
  expect(logs).toContain(`Hosting token for Sam: ${"t".repeat(43)}`);
  expect(logs).toContain("Released Alex's lease (they were hosting at 100.64.0.3).");
  expect(logs.join("\n")).toContain("World: test-1 (Minecraft 26.3), rev 4");
  expect(logs).toContain("Hosting: nobody");
  expect(logs).toContain("Tokens: Alex, Sam (revoked)");
});

test("admin commands without MC_ADMIN_SECRET explain what's missing", async () => {
  await expect(runAdmin({ kind: "admin-status" }, deps(worker().fetch, [], {}))).rejects.toThrow("MC_ADMIN_SECRET");
});
