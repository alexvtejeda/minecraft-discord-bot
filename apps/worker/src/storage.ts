import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

export const URL_TTL_SECONDS = 3600;

export interface PutTarget {
  url: string;
  /** Headers the uploader must send exactly; the checksum is part of the signature. */
  headers: Record<string, string>;
}

export interface Storage {
  getUrl(key: string): Promise<string>;
  putTarget(key: string, sha256Hex: string): Promise<PutTarget>;
}

export function hexToBase64(hex: string): string {
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

export function base64ToHex(b64: string): string {
  return [...atob(b64)].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, "");
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

type R2Env = Pick<Env, "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "R2_ACCOUNT_ID" | "R2_BUCKET_NAME">;

/** Presigned URLs against R2's S3 endpoint. Large files never pass through the Worker. */
export function r2Storage(env: R2Env, now: () => Date = () => new Date()): Storage {
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const base = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/`;
  const sign = async (key: string, method: "GET" | "PUT", headers: Record<string, string>) => {
    const url = new URL(base + encodeKey(key));
    url.searchParams.set("X-Amz-Expires", String(URL_TTL_SECONDS));
    const req = await aws.sign(url.toString(), { method, headers, aws: { signQuery: true, datetime: amzDate(now()) } });
    return req.url;
  };
  return {
    getUrl: (key) => sign(key, "GET", {}),
    async putTarget(key, sha256Hex) {
      const headers = { "x-amz-checksum-sha256": hexToBase64(sha256Hex) };
      return { url: await sign(key, "PUT", headers), headers };
    },
  };
}

/** URLs to this Worker's own /dev/r2 route, for wrangler dev and tests (Miniflare has no S3 endpoint). */
export function devStorage(origin: string): Storage {
  const url = (key: string) => `${origin}/dev/r2/${encodeKey(key)}`;
  return {
    getUrl: async (key) => url(key),
    putTarget: async (key, sha256Hex) => ({ url: url(key), headers: { "x-amz-checksum-sha256": hexToBase64(sha256Hex) } }),
  };
}

export function storageFor(env: Env, requestUrl: string): Storage {
  return env.DEV_R2_PROXY === "1" ? devStorage(new URL(requestUrl).origin) : r2Storage(env);
}
