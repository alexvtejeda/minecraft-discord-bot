import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdminConfig, loadHostConfig } from "../src/host/config";

const dir = () => mkdtempSync(join(tmpdir(), "mc-hostcfg-"));

test("host config comes from the environment first, then agent.json", async () => {
  const d = dir();
  writeFileSync(join(d, "agent.json"), JSON.stringify({ workerUrl: "https://file.test/", token: "file-token" }));
  expect(await loadHostConfig({}, d)).toEqual({ workerUrl: "https://file.test", token: "file-token" });
  expect(await loadHostConfig({ MC_WORKER_URL: "https://env.test", MC_TOKEN: "env-token" }, d)).toEqual({
    workerUrl: "https://env.test",
    token: "env-token",
  });
});

test("missing host config explains how to set it up", async () => {
  await expect(loadHostConfig({}, dir())).rejects.toThrow("isn't set up to host yet");
});

test("a damaged agent.json is reported", async () => {
  const d = dir();
  writeFileSync(join(d, "agent.json"), "{nope");
  await expect(loadHostConfig({}, d)).rejects.toThrow("is damaged");
});

test("admin config needs a worker URL and the admin secret", async () => {
  const d = dir();
  expect(await loadAdminConfig({ MC_WORKER_URL: "https://w.test", MC_ADMIN_SECRET: "s" }, d)).toEqual({
    workerUrl: "https://w.test",
    secret: "s",
  });
  writeFileSync(join(d, "admin.json"), JSON.stringify({ workerUrl: "https://f.test", secret: "fs" }));
  expect(await loadAdminConfig({}, d)).toEqual({ workerUrl: "https://f.test", secret: "fs" });
  await expect(loadAdminConfig({}, dir())).rejects.toThrow("MC_ADMIN_SECRET");
});
