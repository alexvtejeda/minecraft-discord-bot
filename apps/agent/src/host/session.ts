import type { SessionDeps } from "./deps";
import { prepare } from "./prepare";
import { runHosted } from "./run";

/** mc-host start: prepare (recovery, claim, download, build), then run until the server stops. */
export async function hostSession(deps: SessionDeps): Promise<void> {
  await runHosted(deps, await prepare(deps));
}
