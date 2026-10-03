import { Hono } from "hono";
import type { AppEnv } from "./env";
import { ApiError, handleError } from "./errors";
import { dev } from "./routes/dev";
import { agent } from "./routes/agent";
import { admin } from "./routes/admin";
import { enroll, setupScript } from "./routes/enroll";
import { interactions } from "./routes/interactions";
import { jars } from "./routes/jars";
import { modpack } from "./routes/modpack";

export const app = new Hono<AppEnv>();
app.onError(handleError);
app.notFound((c) => handleError(new ApiError("not_found", "There's nothing at this address."), c));
app.get("/health", (c) => c.text("ok"));
app.route("/dev", dev);
app.route("/admin", admin);
app.route("/agent", agent);
app.route("/interactions", interactions);
app.route("/modpack", modpack);
app.route("/jars", jars);
app.route("/s", setupScript);
app.route("/enroll", enroll);

export default app;
