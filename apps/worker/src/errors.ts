import type { ErrorBody, ErrorCode, LeaseInfo } from "@mc/protocol";
import type { Context } from "hono";
import type { z } from "zod";

const STATUS: Record<ErrorCode, 400 | 401 | 404 | 409 | 410 | 426 | 500 | 502> = {
  unauthorized: 401,
  bad_request: 400,
  not_found: 404,
  no_active_world: 404,
  lease_held: 409,
  lease_lost: 409,
  stale_rev: 409,
  conflict: 409,
  upload_missing: 409,
  expired: 410,
  outdated: 426,
  upstream: 502,
  internal: 500,
};

/** An error whose message is shown to the person running mc-host. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly holder?: LeaseInfo,
  ) {
    super(message);
  }

  get status() {
    return STATUS[this.code];
  }

  body(): ErrorBody {
    return { error: this.code, message: this.message, ...(this.holder ? { holder: this.holder } : {}) };
  }
}

export function handleError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return c.json(err.body(), err.status);
  console.error(err);
  const body: ErrorBody = { error: "internal", message: "Something went wrong on the server. Try again in a minute." };
  return c.json(body, 500);
}

export async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw new ApiError("bad_request", "The request body isn't valid JSON.");
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError("bad_request", r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  }
  return r.data;
}
