import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";

type Env = Record<string, string | undefined>;

export interface HostConfig {
  workerUrl: string;
  token: string;
}

export interface AdminConfig {
  workerUrl: string;
  secret: string;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    // Windows PowerShell 5.1 writes UTF-8 with a BOM, which JSON.parse rejects.
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    throw new UserError(`${path} is damaged. Fix or delete it, then try again.`);
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const trimSlash = (url: string) => url.replace(/\/+$/, "");

export async function loadHostConfig(env: Env, configDir: string): Promise<HostConfig> {
  const path = join(configDir, "agent.json");
  const file = await readJson(path);
  const workerUrl = env.MC_WORKER_URL ?? str(file.workerUrl);
  const token = env.MC_TOKEN ?? str(file.token);
  if (!workerUrl || !token) {
    throw new UserError(
      `This PC isn't set up to host yet. Run the installer again, or put {"workerUrl": "...", "token": "..."} in ${path}.`,
    );
  }
  return { workerUrl: trimSlash(workerUrl), token };
}

export async function loadAdminConfig(env: Env, configDir: string): Promise<AdminConfig> {
  const path = join(configDir, "admin.json");
  const file = await readJson(path);
  const workerUrl = env.MC_WORKER_URL ?? str(file.workerUrl);
  const secret = env.MC_ADMIN_SECRET ?? str(file.secret);
  if (!workerUrl || !secret) {
    throw new UserError(`Admin commands need MC_WORKER_URL and MC_ADMIN_SECRET, or {"workerUrl", "secret"} in ${path}.`);
  }
  return { workerUrl: trimSlash(workerUrl), secret };
}
