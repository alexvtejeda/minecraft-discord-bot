import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_SECRET: "test-admin",
            R2_ACCESS_KEY_ID: "AKIDTEST",
            R2_SECRET_ACCESS_KEY: "test-secret",
            R2_ACCOUNT_ID: "acct",
            DEV_R2_PROXY: "1",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.vitest.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
