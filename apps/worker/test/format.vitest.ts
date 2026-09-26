import { describe, expect, it } from "vitest";
import { ago, duration, savedBy, size } from "../src/discord/format";

describe("format", () => {
  it("duration", () => {
    expect(duration(30_000)).toBe("less than a minute");
    expect(duration(12 * 60_000)).toBe("12 min");
    expect(duration(72 * 60_000)).toBe("1h 12m");
    expect(duration(120 * 60_000)).toBe("2h");
    expect(duration(26 * 3_600_000)).toBe("1d 2h");
  });

  it("ago", () => {
    expect(ago(10_000)).toBe("just now");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
  });

  it("savedBy", () => {
    expect(savedBy("100000000000000001")).toBe("<@100000000000000001>");
    expect(savedBy("rollback:100000000000000002")).toBe("a rollback by <@100000000000000002>");
    expect(savedBy("admin")).toBe("an import");
  });

  it("size", () => {
    expect(size(5 * 1_048_576)).toBe("5.0 MB");
    expect(size(250 * 1_048_576)).toBe("250 MB");
    expect(size(1536 * 1_048_576)).toBe("1.5 GB");
  });
});
