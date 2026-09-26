import type { Registry } from "../discord/registry";
import { help } from "./help";
import { hostRelease, releaseAction } from "./host-release";
import { join } from "./join";
import { modList } from "./mod-list";
import { modpack } from "./modpack";
import { setup } from "./setup";
import { status } from "./status";
import { archiveAction, worldArchive } from "./world-archive";
import { worldDownload } from "./world-download";
import { newAction, worldNew } from "./world-new";
import { repinAction, worldRepin } from "./world-repin";
import { rollbackAction, worldRollback } from "./world-rollback";

export const REGISTRY: Registry = {
  groups: {
    world: "Download, create, roll back and archive worlds",
    mod: "Mods in the active world",
    host: "The hosting session",
  },
  commands: [help, setup, status, join, modpack, modList, worldDownload, worldNew, worldRollback, worldArchive, worldRepin, hostRelease],
  actions: [newAction, rollbackAction, archiveAction, repinAction, releaseAction],
};
