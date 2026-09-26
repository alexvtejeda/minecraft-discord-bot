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
}

export type AppEnv = { Bindings: Env; Variables: { userId: string; userName: string } };
