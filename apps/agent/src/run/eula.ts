import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig, writeConfig } from "./config";

export const EULA_URL = "https://aka.ms/MinecraftEULA";

/** Ask for the EULA once per PC; never accept on the user's behalf. Returns false if they decline. */
export async function ensureEula(o: {
  configDir: string;
  serverDir: string;
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
}): Promise<boolean> {
  const cfg = await readConfig(o.configDir);
  if (!cfg.eulaAccepted) {
    o.log(`Running a Minecraft server means agreeing to Mojang's EULA: ${EULA_URL}`);
    const answer = (await o.ask('Type "yes" to agree: ')).trim().toLowerCase();
    if (answer !== "yes") return false;
    await writeConfig(o.configDir, { ...cfg, eulaAccepted: true });
  }
  await writeFile(join(o.serverDir, "eula.txt"), "eula=true\n");
  return true;
}
