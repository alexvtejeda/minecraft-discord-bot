import { UserError, type Fetch } from "@mc/profile";
import {
  AGENT_VERSION_HEADER,
  AdminStatusSchema,
  ClaimResponseSchema,
  CommitResponseSchema,
  CreateWorldResponseSchema,
  ErrorBodySchema,
  HeartbeatResponseSchema,
  ManifestSchema,
  MintTokenResponseSchema,
  OkSchema,
  ReleaseResponseSchema,
  UploadTargetSchema,
  type AdminStatus,
  type ClaimResponse,
  type CommitRequest,
  type CreateWorldRequest,
  type CreateWorldResponse,
  type ImportCommitRequest,
  type ImportUrlRequest,
  type LeaseInfo,
  type Manifest,
  type MintTokenRequest,
  type UploadTarget,
  type UploadUrlRequest,
} from "@mc/protocol";
import type { z } from "zod";
import { VERSION } from "../version";

/** Someone else holds the lease. */
export class LeaseHeldError extends UserError {
  constructor(
    message: string,
    readonly holder: LeaseInfo,
  ) {
    super(message);
  }
}
/** This session's lease is gone: another claim rotated it, or a maintainer released it. */
export class LeaseLostError extends UserError {}
/** The world moved on past this copy's base rev. */
export class StaleRevError extends UserError {}
/** The Worker couldn't be reached, or answered with something that isn't our API. */
export class OfflineError extends UserError {}

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Client {
  fetch: Fetch;
  base: string;
  secret: string;
}

async function request<T>(c: Client, method: "GET" | "POST", path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await c.fetch(`${c.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${c.secret}`,
        [AGENT_VERSION_HEADER]: VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new OfflineError(
      `Can't reach the server list at ${c.base}. Check your internet connection and try again. (${(err as Error).message})`,
    );
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (res.ok) {
    const parsed = schema.safeParse(data);
    if (parsed.success) return parsed.data;
    throw new UserError(`The server list sent a reply this version of mc-host doesn't understand (${path}). Update mc-host.`);
  }
  const err = ErrorBodySchema.safeParse(data);
  if (!err.success) {
    throw new OfflineError(`The server list at ${c.base} answered HTTP ${res.status}. Try again in a few minutes.`);
  }
  const { error, message, holder } = err.data;
  if (error === "lease_held" && holder) {
    throw new LeaseHeldError(`${holder.name} is already hosting at ${holder.hostAddress} (since ${hhmm(holder.claimedAt)}).`, holder);
  }
  if (error === "lease_lost") throw new LeaseLostError(message);
  if (error === "stale_rev") throw new StaleRevError(message);
  throw new UserError(message);
}

export interface AgentApi {
  manifest(): Promise<Manifest>;
  claim(hostAddress: string): Promise<ClaimResponse>;
  heartbeat(sessionId: string): Promise<void>;
  release(sessionId: string): Promise<void>;
  uploadUrl(req: UploadUrlRequest): Promise<UploadTarget>;
  /** Returns the committed rev. */
  commit(req: CommitRequest): Promise<number>;
}

export function createAgentApi(o: { workerUrl: string; token: string; fetch: Fetch }): AgentApi {
  const c: Client = { fetch: o.fetch, base: o.workerUrl.replace(/\/+$/, ""), secret: o.token };
  return {
    manifest: () => request(c, "GET", "/agent/manifest", ManifestSchema),
    claim: (hostAddress) => request(c, "POST", "/agent/lease/claim", ClaimResponseSchema, { hostAddress }),
    heartbeat: async (sessionId) => {
      await request(c, "POST", "/agent/lease/heartbeat", HeartbeatResponseSchema, { sessionId });
    },
    release: async (sessionId) => {
      await request(c, "POST", "/agent/lease/release", OkSchema, { sessionId });
    },
    uploadUrl: (req) => request(c, "POST", "/agent/snapshot/upload-url", UploadTargetSchema, req),
    commit: async (req) => (await request(c, "POST", "/agent/snapshot/commit", CommitResponseSchema, req)).rev,
  };
}

export interface AdminApi {
  createWorld(req: CreateWorldRequest): Promise<CreateWorldResponse>;
  importUrl(worldId: string, req: ImportUrlRequest): Promise<UploadTarget>;
  importCommit(worldId: string, req: ImportCommitRequest): Promise<number>;
  mintToken(req: MintTokenRequest): Promise<string>;
  releaseLease(): Promise<LeaseInfo | null>;
  status(): Promise<AdminStatus>;
}

export function createAdminApi(o: { workerUrl: string; secret: string; fetch: Fetch }): AdminApi {
  const c: Client = { fetch: o.fetch, base: o.workerUrl.replace(/\/+$/, ""), secret: o.secret };
  return {
    createWorld: (req) => request(c, "POST", "/admin/worlds", CreateWorldResponseSchema, req),
    importUrl: (id, req) => request(c, "POST", `/admin/worlds/${encodeURIComponent(id)}/import-url`, UploadTargetSchema, req),
    importCommit: async (id, req) =>
      (await request(c, "POST", `/admin/worlds/${encodeURIComponent(id)}/import-commit`, CommitResponseSchema, req)).rev,
    mintToken: async (req) => (await request(c, "POST", "/admin/tokens", MintTokenResponseSchema, req)).token,
    releaseLease: async () => (await request(c, "POST", "/admin/lease/release", ReleaseResponseSchema, {})).released,
    status: () => request(c, "GET", "/admin/status", AdminStatusSchema),
  };
}
