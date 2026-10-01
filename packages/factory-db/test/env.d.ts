import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      MIGRATIONS: D1Migration[];
    }
  }
}
