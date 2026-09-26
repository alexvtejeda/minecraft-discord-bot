import { Hono } from "hono";
import type { AppEnv } from "./env";
import { ApiError, handleError } from "./errors";

export const app = new Hono<AppEnv>();
app.onError(handleError);
app.notFound((c) => handleError(new ApiError("not_found", "There's nothing at this address."), c));
app.get("/health", (c) => c.text("ok"));
// routers: mounted by later tasks

export default app;
