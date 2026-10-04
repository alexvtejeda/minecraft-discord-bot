import { expect, test } from "bun:test";
import {
  CommitRequestSchema,
  CreateWorldRequestSchema,
  ErrorBodySchema,
  LobbyClaimRequestSchema,
  LobbyTokenRequestSchema,
  ManifestSchema,
  MintTokenRequestSchema,
  Sha256Schema,
  WorldNameSchema,
} from "../src/index";

const SHA = "a".repeat(64);

test("sha256 must be 64 lowercase hex chars", () => {
  expect(Sha256Schema.safeParse(SHA).success).toBe(true);
  expect(Sha256Schema.safeParse("A".repeat(64)).success).toBe(false);
  expect(Sha256Schema.safeParse("a".repeat(63)).success).toBe(false);
});

test("world names are short lowercase slugs", () => {
  expect(WorldNameSchema.safeParse("adventure-2026-09-26").success).toBe(true);
  expect(WorldNameSchema.safeParse("-bad").success).toBe(false);
  expect(WorldNameSchema.safeParse("Bad").success).toBe(false);
  expect(WorldNameSchema.safeParse("a".repeat(41)).success).toBe(false);
});

test("create-world defaults replace and imported to false", () => {
  const r = CreateWorldRequestSchema.parse({ name: "w", profile: {}, lockfile: {} });
  expect(r.replace).toBe(false);
  expect(r.imported).toBe(false);
});

test("commit needs a session, a positive rev, size and sha256", () => {
  const ok = { sessionId: "s".repeat(16), rev: 1, key: "worlds/w/1-x.zip", size: 10, sha256: SHA };
  expect(CommitRequestSchema.safeParse(ok).success).toBe(true);
  expect(CommitRequestSchema.safeParse({ ...ok, rev: 0 }).success).toBe(false);
  expect(CommitRequestSchema.safeParse({ ...ok, sessionId: "short" }).success).toBe(false);
});

test("manifest accepts a fresh world with no snapshot and no lease", () => {
  const m = ManifestSchema.parse({
    world: { id: "w", name: "w", minecraft: "26.3" },
    profile: {},
    lockfile: {},
    pregenDone: false,
    latest: null,
    lease: null,
  });
  expect(m.latest).toBeNull();
});

test("error bodies carry a known code and an optional holder", () => {
  const holder = { name: "Alex", hostAddress: "100.64.0.3", claimedAt: 1, expiresAt: 2 };
  expect(ErrorBodySchema.safeParse({ error: "lease_held", message: "m", holder }).success).toBe(true);
  expect(ErrorBodySchema.safeParse({ error: "nope", message: "m" }).success).toBe(false);
});

test("discord ids are digits", () => {
  expect(MintTokenRequestSchema.safeParse({ discordId: "123456789012345678", name: "Alex" }).success).toBe(true);
  expect(MintTokenRequestSchema.safeParse({ discordId: "alex", name: "Alex" }).success).toBe(false);
});

test("a manifest from an older Worker has no lobby", () => {
  const m = ManifestSchema.parse({
    world: { id: "w", name: "w", minecraft: "26.3" },
    profile: {},
    lockfile: {},
    pregenDone: false,
    latest: null,
    lease: null,
  });
  expect(m.lobby).toBeNull();
  expect(ManifestSchema.parse({ ...m, lobby: { address: "100.64.0.50" } }).lobby).toEqual({ address: "100.64.0.50" });
});

test("lobby names are slugs, and a claim needs an address and a machine", () => {
  expect(LobbyTokenRequestSchema.safeParse({ name: "fedora" }).success).toBe(true);
  expect(LobbyTokenRequestSchema.safeParse({ name: "Fedora Box" }).success).toBe(false);
  expect(LobbyClaimRequestSchema.safeParse({ address: "100.64.0.50", machine: "fedora" }).success).toBe(true);
  expect(LobbyClaimRequestSchema.safeParse({ address: "", machine: "fedora" }).success).toBe(false);
});
