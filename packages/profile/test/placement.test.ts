import { expect, test } from "bun:test";
import type { MrProject } from "../src/modrinth";
import { clampToProject, mergePlacement, placementOf, sideFromMetadata, sideOf } from "../src/placement";

const project = (client_side: MrProject["client_side"], server_side: MrProject["server_side"]): MrProject => ({
  id: "P",
  slug: "p",
  title: "P",
  client_side,
  server_side,
});

test("placementOf and sideOf round-trip", () => {
  expect(sideOf(placementOf("server"))).toEqual({ side: "server", clientOptional: false });
  expect(sideOf(placementOf("both"))).toEqual({ side: "both", clientOptional: false });
  expect(sideOf(placementOf("both", true))).toEqual({ side: "both", clientOptional: true });
  expect(sideOf(placementOf("client-optional"))).toEqual({ side: "client-optional", clientOptional: true });
});

test("merge widens: server + both(required) = both required", () => {
  expect(sideOf(mergePlacement(placementOf("server"), placementOf("both")))).toEqual({ side: "both", clientOptional: false });
});

test("merge: server + client-optional = both, optional on the client", () => {
  expect(sideOf(mergePlacement(placementOf("server"), placementOf("client-optional")))).toEqual({ side: "both", clientOptional: true });
});

test("merge: optional + required on the client = required", () => {
  expect(sideOf(mergePlacement(placementOf("both", true), placementOf("both")))).toEqual({ side: "both", clientOptional: false });
});

test("clampToProject keeps a server-only library off clients", () => {
  const clamped = clampToProject(placementOf("both"), project("unsupported", "required"));
  expect(sideOf(clamped)).toEqual({ side: "server", clientOptional: false });
});

test("clampToProject keeps a client-only library off the server", () => {
  const clamped = clampToProject(placementOf("both", true), project("required", "unsupported"));
  expect(sideOf(clamped)).toEqual({ side: "client-optional", clientOptional: true });
});

test("sideFromMetadata", () => {
  expect(sideFromMetadata(project("required", "unsupported"))).toBe("client-optional");
  expect(sideFromMetadata(project("required", "required"))).toBe("both");
  expect(sideFromMetadata(project("optional", "required"))).toBe("server");
  expect(sideFromMetadata(project("unsupported", "required"))).toBe("server");
});

// Final review I3
test("a client-only library that a both mod requires stays required on the client", () => {
  const clamped = clampToProject(placementOf("both"), project("required", "unsupported"));
  expect(sideOf(clamped)).toEqual({ side: "client-optional", clientOptional: false });
});
