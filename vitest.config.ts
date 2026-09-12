import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Runs in Node.js: read the SQL files and hand them to the runtime as a test-only binding.
      const migrations = await readD1Migrations("./migrations");
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // The top-level vars already use the local doors. These add the development
            // owner identity, so admin-host requests in tests act as the owner in OWNERS.
            ENVIRONMENT: "development",
            DEV_OWNER_EMAIL: "mitsosmitsis@gmail.com",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
