export interface Env {
  LEADS: D1Database;
  FACTORY: D1Database;
  DRAIN_TOKEN?: string;
  HANDOFF_KEY?: string;
  HANDOFF_KEY_ID?: string;
  FORM_SITE_ID?: string;
  FORM_VERSION?: string;
  CONSENT_VERSION?: string;
  PARTNER_LIST_VERSION?: string;
  /** Private panel lifecycle request account context, supplied by the tenant's BFF binding. */
  LIFECYCLE_ACCOUNT?: string;
  /** Mailing cron (CO-7). All four are Worker secrets; the cron skips cleanly until they are set. */
  LISTMONK_URL?: string;
  LISTMONK_USER?: string;
  LISTMONK_TOKEN?: string;
  /** JSON object: {"<brand_id>": <listmonk list id>}. */
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
