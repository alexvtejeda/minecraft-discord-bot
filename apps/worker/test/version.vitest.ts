import { describe, expect, it } from "vitest";
import { atLeast } from "../src/version";
import { addUser, call } from "./helpers";

const OUTDATED = { error: "outdated", message: "mc-host is out of date. Run `/setup host` in Discord to update." };

describe("atLeast", () => {
  it("compares versions number by number", () => {
    expect(atLeast("0.2.0", "0.2.0")).toBe(true);
    expect(atLeast("0.10.0", "0.9.9")).toBe(true);
    expect(atLeast("1.0.0", "0.2.0")).toBe(true);
    expect(atLeast("0.1.9", "0.2.0")).toBe(false);
  });

  it("treats a missing or odd version as too old", () => {
    expect(atLeast(undefined, "0.2.0")).toBe(false);
    expect(atLeast("v0.2.0", "0.2.0")).toBe(false);
    expect(atLeast("0.2", "0.2.0")).toBe(false);
  });
});

describe("agent version check", () => {
  it("turns away an agent below MIN_AGENT_VERSION with 426", async () => {
    const token = await addUser();
    const r = await call("GET", "/agent/manifest", { token, agentVersion: "0.1.9" });
    expect(r.status).toBe(426);
    expect(r.body).toEqual(OUTDATED);
  });

  it("turns away an agent that sends no version", async () => {
    const token = await addUser();
    const r = await call("GET", "/agent/manifest", { token, agentVersion: null });
    expect(r.status).toBe(426);
  });

  it("checks the version before the token, so an old agent hears it needs updating", async () => {
    expect((await call("GET", "/agent/manifest", { token: "wrong", agentVersion: "0.1.0" })).status).toBe(426);
  });

  it("lets a current agent through", async () => {
    const token = await addUser();
    const r = await call("GET", "/agent/manifest", { token, agentVersion: "0.2.0" });
    expect(r.status).toBe(404); // no active world, which is past the version check
    expect(r.body.error).toBe("no_active_world");
  });
});
