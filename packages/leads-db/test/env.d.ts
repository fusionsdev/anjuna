import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      V1_DB: D1Database;
      MIGRATIONS: D1Migration[];
      V1_SCHEMA: D1Migration[];
      V1_MIGRATION_TEXTS: Record<string, string>;
    }
  }
}
