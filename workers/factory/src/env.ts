declare global {
  namespace Cloudflare {
    interface Env {
      /** Factory D1: templates, brands, installs, install_receipts, audit_log. */
      FACTORY: D1Database;
      /** R2: sealed template archives, form artifacts (read) + rendered brand builds (write). */
      ARTIFACTS: R2Bucket;
      /** Workflow binding — install-brand (same-script). */
      INSTALL_WORKFLOW: Workflow;
      /** Workflow binding — rollback-brand (same-script). */
      ROLLBACK_WORKFLOW: Workflow;
      /** Workflow binding — upgrade-all (same-script). */
      UPGRADE_WORKFLOW: Workflow;
      CORE_LIFECYCLE: Fetcher;
      /** Target Cloudflare account for Workers Upload API calls. */
      CF_ACCOUNT_ID: string;
      /** Scoped secret: Workers Scripts:Edit, Workers Domains:Edit, DNS:Read, Zones:Read. */
      CF_API_TOKEN: string;
      CORE_TOKEN: string;
      CORE_ACCOUNT: string;
      CORE_DOMAIN: string;
      CORE_SERVICE_NAME: string;
      DEFAULT_FORM_ROUTE: string;
      DEFAULT_AMOUNT_BUCKETS: string;
      LEADSGATE_AID: string;
      LEADSGATE_PREPOP_BASE: string;
    }
  }
}

export type Env = Cloudflare.Env;
