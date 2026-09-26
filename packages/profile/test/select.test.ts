import { expect, test } from "bun:test";
import { pickVersion, primaryFile } from "../src/select";
import { makeVersion } from "./fakes";

const v = (id: string, type: "release" | "beta" | "alpha", date: string) =>
  makeVersion("P", { id, version_type: type, date_published: date });

test("prefers the newest release over a newer beta", () => {
  const picked = pickVersion([v("b2", "beta", "2026-09-10T00:00:00Z"), v("r1", "release", "2026-09-01T00:00:00Z"), v("r0", "release", "2026-08-01T00:00:00Z")]);
  expect(picked?.id).toBe("r1");
});

test("falls back to beta, then alpha", () => {
  expect(pickVersion([v("a1", "alpha", "2026-09-10T00:00:00Z"), v("b1", "beta", "2026-09-01T00:00:00Z")])?.id).toBe("b1");
  expect(pickVersion([v("a1", "alpha", "2026-09-10T00:00:00Z")])?.id).toBe("a1");
});

test("a pin matches version_number or id, even if not newest", () => {
  const list = [v("r2", "release", "2026-09-10T00:00:00Z"), makeVersion("P", { id: "abc123", version_number: "26.3-11.4.0" })];
  expect(pickVersion(list, "26.3-11.4.0")?.id).toBe("abc123");
  expect(pickVersion(list, "abc123")?.id).toBe("abc123");
  expect(pickVersion(list, "nope")).toBeNull();
});

test("ignores versions that are not for Fabric", () => {
  expect(pickVersion([makeVersion("P", { id: "q", loaders: ["quilt"] })])).toBeNull();
});

test("returns null for no versions", () => {
  expect(pickVersion([])).toBeNull();
});

test("primaryFile prefers the primary file and errors when there is none", () => {
  const ver = makeVersion("P", { id: "x" });
  ver.files = [{ ...ver.files[0]!, filename: "sources.jar", primary: false }, { ...ver.files[0]!, filename: "main.jar", primary: true }];
  expect(primaryFile(ver, "Mod").filename).toBe("main.jar");
  expect(() => primaryFile({ ...ver, files: [] }, "Mod")).toThrow(/Mod x has no downloadable file/);
});
