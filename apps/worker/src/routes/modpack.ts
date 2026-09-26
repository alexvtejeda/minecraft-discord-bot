import { Hono } from "hono";
import type { AppEnv } from "../env";
import { worldMrpack } from "../mrpack";
import type { WorldRow } from "../worlds";

/** Unauthenticated so Prism can import straight from the URL. The pack only holds Modrinth links. */
export const modpack = new Hono<AppEnv>();

modpack.get("/:file", async (c) => {
  const m = /^([A-Za-z0-9-]{1,64})\.mrpack$/.exec(c.req.param("file"));
  const world = m ? await c.env.DB.prepare("SELECT * FROM worlds WHERE id = ?").bind(m[1]).first<WorldRow>() : null;
  if (!world) return c.text("There's no modpack at this address. Run /modpack in Discord for the current link.", 404);
  return new Response(await worldMrpack(world), {
    headers: {
      "Content-Type": "application/x-modrinth-modpack+zip",
      "Content-Disposition": `attachment; filename="${world.name}.mrpack"`,
      "Cache-Control": "no-cache",
    },
  });
});
