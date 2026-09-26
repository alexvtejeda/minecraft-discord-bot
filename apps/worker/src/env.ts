export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ADMIN_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  /** "1" only in tests and `wrangler dev`: hand out /dev/r2 URLs instead of presigned R2 URLs. */
  DEV_R2_PROXY?: string;
  DISCORD_APP_ID: string;
  /** Hex Ed25519 public key from the developer portal. */
  DISCORD_PUBLIC_KEY: string;
  DISCORD_GUILD_ID: string;
  /** Empty means announcements are off. */
  ANNOUNCE_CHANNEL_ID: string;
  MAINTAINER_ROLE_ID: string;
  DISCORD_BOT_TOKEN: string;
  /** Agents older than this (or sending no version) get 426 and are told to update. */
  MIN_AGENT_VERSION: string;
}

export type AppEnv = { Bindings: Env; Variables: { userId: string; userName: string } };
