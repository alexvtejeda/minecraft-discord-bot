type ProjectEnv = import("../src/env").Env;

declare namespace Cloudflare {
  interface Env extends ProjectEnv {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    TEST_DISCORD_JWK: string;
  }
}
