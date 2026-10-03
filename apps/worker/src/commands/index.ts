import type { Registry } from "../discord/registry";
import { help } from "./help";
import { hostRelease, releaseAction } from "./host-release";
import { join } from "./join";
import { modList } from "./mod-list";
import { modUpload } from "./mod-upload";
import { modpack } from "./modpack";
import { setupHelp, setupHost, setupPlay } from "./setup";
import { status } from "./status";
import { revokeAction, tailnetRevoke } from "./tailnet-revoke";
import { archiveAction, worldArchive } from "./world-archive";
import { worldDownload } from "./world-download";
import { newAction, worldNew } from "./world-new";
import { repinAction, worldRepin } from "./world-repin";
import { rollbackAction, worldRollback } from "./world-rollback";

export const REGISTRY: Registry = {
  groups: {
    world: "Download, create, roll back and archive worlds",
    mod: "Mods in the active world, and uploading jars",
    host: "The hosting session",
    setup: "Put your Windows PC on the Minecraft network",
    tailnet: "The Minecraft network",
  },
  commands: [help, setupPlay, setupHost, setupHelp, status, join, modpack, modList, modUpload, worldDownload, worldNew, worldRollback, worldArchive, worldRepin, hostRelease, tailnetRevoke],
  actions: [newAction, rollbackAction, archiveAction, repinAction, releaseAction, revokeAction],
};
