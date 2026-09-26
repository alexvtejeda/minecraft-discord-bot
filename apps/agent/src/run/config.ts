import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";

export interface AgentConfig {
  eulaAccepted?: boolean;
}

export async function readConfig(dir: string): Promise<AgentConfig> {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as AgentConfig;
  } catch {
    throw new UserError(`${path} is damaged. Delete it and try again (you'll be asked about the EULA once more).`);
  }
}

export async function writeConfig(dir: string, cfg: AgentConfig): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}
