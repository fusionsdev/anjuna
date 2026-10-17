import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      AUTH: D1Database;
      FACTORY: D1Database;
      ARTIFACTS: R2Bucket;
      AUTH_MIGRATIONS: D1Migration[];
      FACTORY_MIGRATIONS: D1Migration[];
    }
  }
}
