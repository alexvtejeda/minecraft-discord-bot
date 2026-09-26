import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256");
const Rev = z.number().int().nonnegative();
const PositiveRev = z.number().int().positive();
const Size = z.number().int().positive();
const SessionId = z.string().min(16).max(64);

export const ERROR_CODES = [
  "unauthorized",
  "bad_request",
  "not_found",
  "no_active_world",
  "lease_held",
  "lease_lost",
  "stale_rev",
  "conflict",
  "upload_missing",
  "expired",
  "outdated",
  "upstream",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every agent request carries its mc-host version, so the Worker can turn away outdated ones. */
export const AGENT_VERSION_HEADER = "X-MC-Agent-Version";

export const LeaseInfoSchema = z.object({
  name: z.string(),
  hostAddress: z.string(),
  claimedAt: z.number(),
  expiresAt: z.number(),
});
export type LeaseInfo = z.infer<typeof LeaseInfoSchema>;

export const ErrorBodySchema = z.object({
  error: z.enum(ERROR_CODES),
  message: z.string(),
  holder: LeaseInfoSchema.optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const SnapshotRefSchema = z.object({ rev: PositiveRev, sha256: Sha256Schema, size: Size, url: z.url() });
export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;

export const ManifestSchema = z.object({
  world: z.object({ id: z.string(), name: z.string(), minecraft: z.string() }),
  /** The profile as parsed when the world was created (parse again with parseProfile). */
  profile: z.unknown(),
  /** The pinned lockfile (parse again with parseLock). */
  lockfile: z.unknown(),
  pregenDone: z.boolean(),
  latest: SnapshotRefSchema.nullable(),
  /** Null when nobody holds the lease or it has expired. */
  lease: LeaseInfoSchema.extend({ you: z.boolean() }).nullable(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const ClaimRequestSchema = z.object({ hostAddress: z.string().min(1).max(64) });
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;
export const ClaimResponseSchema = z.object({ sessionId: SessionId, baseRev: Rev, expiresAt: z.number() });
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;
export const SessionRequestSchema = z.object({ sessionId: SessionId });
export type SessionRequest = z.infer<typeof SessionRequestSchema>;
export const HeartbeatResponseSchema = z.object({ expiresAt: z.number() });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;
export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;

export const UploadUrlRequestSchema = z.object({ sessionId: SessionId, baseRev: Rev, size: Size, sha256: Sha256Schema });
export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;
export const UploadTargetSchema = z.object({
  rev: PositiveRev,
  key: z.string().min(1),
  url: z.url(),
  /** Headers the PUT must send exactly (the checksum is part of the signature). */
  headers: z.record(z.string(), z.string()),
});
export type UploadTarget = z.infer<typeof UploadTargetSchema>;
export const CommitRequestSchema = z.object({
  sessionId: SessionId,
  rev: PositiveRev,
  key: z.string().min(1),
  size: Size,
  sha256: Sha256Schema,
  pregenDone: z.boolean().optional(),
});
export type CommitRequest = z.infer<typeof CommitRequestSchema>;
export const CommitResponseSchema = z.object({ rev: PositiveRev });
export type CommitResponse = z.infer<typeof CommitResponseSchema>;

export const WorldNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be up to 40 lowercase letters, digits and dashes, starting with a letter or digit");
export const CreateWorldRequestSchema = z.object({
  name: WorldNameSchema,
  profile: z.unknown(),
  lockfile: z.unknown(),
  replace: z.boolean().default(false),
  imported: z.boolean().default(false),
});
export type CreateWorldRequest = z.input<typeof CreateWorldRequestSchema>;
export const CreateWorldResponseSchema = z.object({ id: z.string(), name: z.string() });
export type CreateWorldResponse = z.infer<typeof CreateWorldResponseSchema>;
export const ImportUrlRequestSchema = z.object({ size: Size, sha256: Sha256Schema });
export type ImportUrlRequest = z.infer<typeof ImportUrlRequestSchema>;
export const ImportCommitRequestSchema = z.object({ key: z.string().min(1), size: Size, sha256: Sha256Schema });
export type ImportCommitRequest = z.infer<typeof ImportCommitRequestSchema>;
export const MintTokenRequestSchema = z.object({
  discordId: z.string().regex(/^\d{5,25}$/, "must be a Discord user ID (digits only)"),
  name: z.string().min(1).max(32),
});
export type MintTokenRequest = z.infer<typeof MintTokenRequestSchema>;
export const MintTokenResponseSchema = z.object({ token: z.string().min(32) });
export type MintTokenResponse = z.infer<typeof MintTokenResponseSchema>;
export const ReleaseResponseSchema = z.object({ released: LeaseInfoSchema.nullable() });
export type ReleaseResponse = z.infer<typeof ReleaseResponseSchema>;
export const AdminStatusSchema = z.object({
  world: z
    .object({
      id: z.string(),
      name: z.string(),
      minecraft: z.string(),
      latestRev: Rev,
      latestAt: z.number().nullable(),
      pregenDone: z.boolean(),
    })
    .nullable(),
  lease: LeaseInfoSchema.nullable(),
  users: z.array(z.object({ discordId: z.string(), name: z.string(), revoked: z.boolean() })),
});
export type AdminStatus = z.infer<typeof AdminStatusSchema>;

const EnrollCode = z.string().min(1).max(32);
export const EnrollRequestSchema = z.object({ code: EnrollCode, join: z.boolean() });
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;
export const EnrollResponseSchema = z.object({ hostname: z.string(), authKey: z.string().optional(), token: z.string().optional() });
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;
/** nodeId is `Self.ID` from `tailscale status --json`, e.g. "nABC123CNTRL". */
export const EnrollDeviceRequestSchema = z.object({ code: EnrollCode, nodeId: z.string().regex(/^[A-Za-z0-9]{1,64}$/) });
export type EnrollDeviceRequest = z.infer<typeof EnrollDeviceRequestSchema>;
