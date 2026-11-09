export interface Env {
  TRAFFIC_TAIL?: DurableObjectNamespace;
  LEADS: D1Database;
  FACTORY: D1Database;
  DRAIN_TOKEN?: string;
  /** Tenant-wide LeadsGate postback token (Worker secret). Accepted for every brand of this core. */
  POSTBACK_TOKEN?: string;
  HANDOFF_KEY?: string;
  HANDOFF_KEY_ID?: string;
  FORM_SITE_ID?: string;
  FORM_VERSION?: string;
  CONSENT_VERSION?: string;
  PARTNER_LIST_VERSION?: string;
  /** Private panel lifecycle request account context, supplied by the tenant's BFF binding. */
  LIFECYCLE_ACCOUNT?: string;
  /** Mailing cron (CO-7). Worker secrets; the cron skips cleanly until URL, USER and TOKEN are set. The install workflow uses them to create each brand's list. */
  LISTMONK_URL?: string;
  LISTMONK_USER?: string;
  LISTMONK_TOKEN?: string;
  /** Optional fallback, JSON object {"<brand_id>": <listmonk list id>}, for brands without brand_runtime.listmonk_list_id. */
  LISTMONK_LIST_MAP?: string;
  /** Analytics forward (ADR-0004). Worker secrets; without them core accepts and drops that kind. */
  POSTHOG_KEY?: string;
  /** Ingest origin for the project. Defaults to the PostHog US cloud, as V1 did. */
  POSTHOG_HOST?: string;
  SENTRY_DSN?: string;
  /** Workers Rate Limiting bindings, one per analytics kind (ANALYTICS_RATE_LIMITS). Without them core does not limit. */
  POSTHOG_LIMITER?: RateLimit;
  SENTRY_LIMITER?: RateLimit;
  TELEMETRY_LIMITER?: RateLimit;
  ERRORS_LIMITER?: RateLimit;
}
