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
      /** Target Cloudflare account for Workers Upload API calls. */
      CF_ACCOUNT_ID: string;
      /** Scoped secret: Workers Scripts:Edit, Workers Domains:Edit, DNS:Read, Zones:Read. */
      CF_API_TOKEN: string;
    }
  }
}

export type Env = Cloudflare.Env;
