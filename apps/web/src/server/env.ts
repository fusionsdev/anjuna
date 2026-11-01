/** Bindings and vars of the `anjuna-web` Worker. See wrangler.jsonc. */
export interface Env {
  /** better-auth tables (`@anjuna/auth-db`). */
  AUTH: D1Database;
  /** `audit_log` and the factory tables (`@anjuna/factory-db`). The panel never binds the leads D1. */
  FACTORY: D1Database;
  /** Service Binding to the `anjuna-core` Worker (admin API). */
  CORE?: Fetcher; // absent until T6 deploys anjuna-core; MOCK_CORE=1 is used meanwhile
  /** Service Binding to the `anjuna-factory` Worker (install / rollback / upgrade-all Workflows). */
  FACTORY_WORKER?: Fetcher;
  /** Private PanelLifecycleService binding on core. */
  CORE_LIFECYCLE?: Fetcher;
  /** R2 (read): certification screenshots for the Templates screen. */
  ARTIFACTS?: R2Bucket;
  /** Service Binding to anjuna-template-mcp's TemplateImportService (Import from URL). */
  TEMPLATE_MCP?: Fetcher;
  /** Static assets (the SPA). */
  ASSETS: Fetcher;

  /** Secret: better-auth signing secret (`wrangler secret put BETTER_AUTH_SECRET`). */
  BETTER_AUTH_SECRET: string;
  /** Public origin of the panel, e.g. `https://app.aduplift.ai`. */
  BETTER_AUTH_URL: string;

  /** `"1"` serves the admin API from the fixture-backed mock core instead of the CORE binding. */
  MOCK_CORE?: string;
  /** Dev/test only. `"1"` relaxes better-auth origin and cookie checks on loopback. Never set in wrangler.jsonc. */
  DEV_ACCESS_BYPASS?: string;
  DEFAULT_ACCOUNT?: string;
  DEFAULT_AID?: string;
  DEFAULT_PREPOP_BASE?: string;
  DEFAULT_FORM_ROUTE?: string;
  DEFAULT_AMOUNT_BUCKETS?: string;
  DEFAULT_PAYLOAD_VERSION?: string;
}
