import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

// Final review: a root-level ".gitignore" rule once swallowed apps/agent/src/server/.
test("no source file is git-ignored", () => {
  const sources = ["apps/agent/src", "apps/agent/test", "packages/profile/src", "packages/profile/test"].flatMap((dir) =>
    (readdirSync(join(root, dir), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)),
  );
  const p = Bun.spawnSync(["git", "check-ignore", ...sources], { cwd: root });
  expect(p.stdout.toString().trim()).toBe("");
});
