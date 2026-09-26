import type { Registry } from "../discord/registry";
import { help } from "./help";

export const REGISTRY: Registry = {
  groups: {
    world: "Download, create, roll back and archive worlds",
    mod: "Mods in the active world",
    host: "The hosting session",
  },
  commands: [help],
  actions: [],
};
