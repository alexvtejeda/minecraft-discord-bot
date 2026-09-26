import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFabricMeta,
  createModrinthClient,
  createMojangMeta,
  parseProfile,
  resolveProfile,
  USER_AGENT,
} from "../src/index";

const live = !!process.env.LIVE;
const http = { fetch: (i: string, init?: RequestInit) => fetch(i, init), userAgent: USER_AGENT };
const clients = { modrinth: createModrinthClient(http), fabric: createFabricMeta(http), mojang: createMojangMeta(http) };

for (const name of ["vanilla-plus", "adventure"]) {
  test.skipIf(!live)(
    `live: ${name} resolves against Modrinth, Fabric and Mojang`,
    async () => {
      const path = join(import.meta.dir, "../../../profiles", `${name}.json`);
      const profile = parseProfile(JSON.parse(readFileSync(path, "utf8")), `${name}.json`);
      const { lock } = await resolveProfile(profile, clients);
      expect(lock.javaMajor).toBe(25);
      expect(lock.files.length).toBeGreaterThan(5);
      for (const f of lock.files) expect(f.url.startsWith("https://cdn.modrinth.com/")).toBe(true);
    },
    120_000,
  );
}
