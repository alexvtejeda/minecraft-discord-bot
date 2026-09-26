import { Hono } from "hono";
import type { AppEnv } from "./env";
import { ApiError, handleError } from "./errors";
import { dev } from "./routes/dev";
import { agent } from "./routes/agent";
import { admin } from "./routes/admin";

export const app = new Hono<AppEnv>();
app.onError(handleError);
app.notFound((c) => handleError(new ApiError("not_found", "There's nothing at this address."), c));
app.get("/health", (c) => c.text("ok"));
app.route("/dev", dev);
app.route("/admin", admin);
app.route("/agent", agent);
// routers: mounted by later tasks

export default app;
