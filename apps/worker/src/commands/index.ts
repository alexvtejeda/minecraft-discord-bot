import type { Registry } from "../discord/registry";
import { help } from "./help";
import { join } from "./join";
import { modList } from "./mod-list";
import { modpack } from "./modpack";
import { status } from "./status";
import { worldDownload } from "./world-download";

export const REGISTRY: Registry = {
  groups: {
    world: "Download, create, roll back and archive worlds",
    mod: "Mods in the active world",
    host: "The hosting session",
  },
  commands: [help, status, join, modpack, modList, worldDownload],
  actions: [],
};
