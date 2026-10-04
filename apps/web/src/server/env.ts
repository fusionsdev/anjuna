/** Bindings and vars of the `anjuna-web` Worker. See wrangler.jsonc. */
export interface Env {
  /** better-auth tables (`@anjuna/auth-db`). */
  AUTH: D1Database;
  /** `audit_log` and the factory tables (`@anjuna/factory-db`). The panel never binds the leads D1. */
  FACTORY: D1Database;
  /** Service Binding to the `anjuna-core` Worker (admin API). */
  CORE?: Fetcher; // absent until T6 deploys anjuna-core; MOCK_CORE=1 is used meanwhile
  /** Service Binding to the `anjuna-factory` Worker (install / rollback / upgrade-all Workflows). */
  FACTORY_WORKER?: Fetcher; // absent until T10 deploys; routes fall back to queued D1 rows
  /** Static assets (the SPA). */
  ASSETS: Fetcher;

  /** `<team>.cloudflareaccess.com`. A placeholder in git; set by the owner. */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application. A placeholder in git. */
  ACCESS_AUD: string;
  /** Secret: better-auth signing secret (`wrangler secret put BETTER_AUTH_SECRET`). */
  BETTER_AUTH_SECRET: string;
  /** Public origin of the panel, e.g. `https://app.aduplift.ai`. */
  BETTER_AUTH_URL: string;

  /** `"1"` serves the admin API from the fixture-backed mock core instead of the CORE binding. */
  MOCK_CORE?: string;
  /** Dev/test only. `"1"` skips Access JWT verification. Never set in wrangler.jsonc. */
  DEV_ACCESS_BYPASS?: string;
}
