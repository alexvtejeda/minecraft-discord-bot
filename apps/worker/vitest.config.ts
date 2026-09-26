import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway Ed25519 key: tests sign interactions with the private half.
const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });

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
            TEST_DISCORD_JWK: JSON.stringify(jwk),
            DISCORD_PUBLIC_KEY: Buffer.from(jwk.x!, "base64url").toString("hex"),
            DISCORD_APP_ID: "200000000000000001",
            DISCORD_GUILD_ID: "300000000000000001",
            ANNOUNCE_CHANNEL_ID: "",
            MAINTAINER_ROLE_ID: "500000000000000001",
            DISCORD_BOT_TOKEN: "test-bot-token",
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
