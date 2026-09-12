import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs inside workerd before each test file. applyD1Migrations is idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
