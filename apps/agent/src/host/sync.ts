import { rm } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@mc/profile";
import type { SnapshotRef } from "@mc/protocol";
import { LeaseLostError, StaleRevError } from "./api";
import { DOWNLOAD_ATTEMPTS, UPLOAD_ATTEMPTS, type SessionDeps } from "./deps";
import { ChecksumError, extractSnapshot, zipSnapshot } from "./snapshot";
import { tmpDirFor } from "./state";

export class UploadFailedError extends UserError {}

/** upload-url → PUT → commit, retried with backoff. Lease problems are never retried. */
export async function pushZip(
  deps: Pick<SessionDeps, "api" | "upload" | "sleep">,
  o: { sessionId: string; baseRev: number; pregenDone: boolean },
  file: string,
  zipped: { sha256: string; size: number },
): Promise<number> {
  let last: Error | null = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const target = await deps.api.uploadUrl({ sessionId: o.sessionId, baseRev: o.baseRev, ...zipped });
      await deps.upload(target, file);
      return await deps.api.commit({ sessionId: o.sessionId, rev: target.rev, key: target.key, ...zipped, pregenDone: o.pregenDone });
    } catch (err) {
      if (err instanceof LeaseLostError || err instanceof StaleRevError) throw err;
      last = err as Error;
      if (attempt < UPLOAD_ATTEMPTS) await deps.sleep(5_000 * 4 ** (attempt - 1));
    }
  }
  throw new UploadFailedError(`Couldn't upload the world after ${UPLOAD_ATTEMPTS} tries (${last?.message}).`);
}

/** Zip a stopped server's snapshot paths and push them as the next rev. */
export async function uploadSnapshot(
  deps: Pick<SessionDeps, "api" | "upload" | "sleep" | "dataDir">,
  o: { sessionId: string; baseRev: number; serverDir: string; levelName: string; pregenDone: boolean },
): Promise<number> {
  const file = join(tmpDirFor(deps.dataDir), `upload-${o.baseRev + 1}.zip`);
  try {
    return await pushZip(deps, o, file, await zipSnapshot(o.serverDir, o.levelName, file));
  } finally {
    await rm(file, { force: true });
  }
}

/** Download a snapshot and unpack it over serverDir, retrying a damaged download. */
export async function fetchSnapshot(
  deps: Pick<SessionDeps, "download" | "log" | "dataDir">,
  latest: SnapshotRef,
  serverDir: string,
  levelName: string,
): Promise<void> {
  const file = join(tmpDirFor(deps.dataDir), `download-${latest.rev}.zip`);
  try {
    for (let attempt = 1; ; attempt++) {
      await deps.download(latest.url, file);
      try {
        await extractSnapshot(file, serverDir, levelName, latest.sha256);
        return;
      } catch (err) {
        if (!(err instanceof ChecksumError)) throw err;
        if (attempt >= DOWNLOAD_ATTEMPTS) throw new UserError("Couldn't download the world. Try again later.");
        deps.log("The downloaded world is damaged. Trying again…");
      }
    }
  } finally {
    await rm(file, { force: true });
  }
}
