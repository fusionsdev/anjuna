/**
 * `leads` D1 schema (core-owned): the V1 schema ported from fusion_formv_v1@8404ec2 plus the
 * Anjuna additions (A/B + keyword attribution, brand_runtime, mailing_outbox).
 *
 * The SQL in `../migrations` is the source of truth (wrangler D1 migration format). Apply with
 * `migrations_dir` pointing at this package's `migrations/` directory. This module only exports
 * the migration list and row types for code that reads/writes these tables.
 */

/** Migration files, in apply order. Kept in sync with `migrations/` by the package tests. */
export const LEADS_DB_MIGRATIONS = [
  "0001_v1_baseline.sql",
  "0002_v1_v2_sessions.sql",
  "0003_anjuna_experiment_keyword.sql",
  "0004_brand_runtime.sql",
  "0005_mailing_outbox.sql",
  "0006_account_credentials.sql",
  "0007_core_rpc.sql",
  "0008_lifecycle.sql",
  "0009_continuation_applicant.sql",
  "0010_zip_lookup_seed.sql",
  "0011_brand_site_text.sql",
  "0012_brand_drain_route.sql",
  "0013_brand_listmonk_list.sql",
  "0014_ad_spend.sql",
] as const;

/** V1 source the baseline is ported from. */
export const V1_PORT_SOURCE = {
  repo: "fusionsdev/fusion_formv_v1",
  branch: "anjuna-port-base",
  commit: "8404ec2",
} as const;

// ---------------------------------------------------------------------------------------------
// conversion_uploads — frozen V1 drain contract. Column-identical to V1 (asserted by tests).
// ---------------------------------------------------------------------------------------------

/** V1 `conversion_uploads` columns, in table order. */
export const CONVERSION_UPLOADS_COLUMNS = [
  "id",
  "lead_id",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "value",
  "currency",
  "occurred_at",
  "google_order_id",
  "status",
  "attempts",
  "last_error",
  "next_attempt_at",
  "created_at",
  "updated_at",
] as const;

/** V1 queue states: pending -> processing -> uploaded | pending (backoff) | dead. */
export type ConversionUploadStatus = "pending" | "processing" | "uploaded" | "dead";

export interface ConversionUploadRow {
  id: number;
  lead_id: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  msclkid: string | null;
  value: number;
  currency: string;
  occurred_at: string;
  google_order_id: string | null;
  status: ConversionUploadStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------------------------
// brand_runtime
// ---------------------------------------------------------------------------------------------

export const FLOW_GATE_MODES = ["param", "signed_cookie"] as const;
export type FlowGateMode = (typeof FLOW_GATE_MODES)[number];

/** Shape stored in `brand_runtime.ab_config_json`. */
export interface AbConfig {
  experiment_id: string;
  variants: { id: string; weight: number }[];
}

/** A `brand_runtime` row as stored (JSON columns are TEXT; booleans are 0/1). */
export interface BrandRuntimeRow {
  brand_id: string;
  account: string;
  /** JSON array of hostnames. */
  hostnames: string;
  drain_key: string;
  /** Hex SHA-256 of the per-brand postback token; never the token itself. */
  postback_token_hash: string | null;
  aid: string;
  prepop_base: string;
  /** JSON array of allowed requested_amount integers. */
  amount_buckets: string;
  flow_gate_mode: FlowGateMode;
  paused: 0 | 1;
  /** JSON-encoded {@link AbConfig}, or null when the brand runs no test. */
  ab_config_json: string | null;
  keyword_default: string | null;
  form_route: string;
  /** Bundle identity, e.g. form@8ba11d3; distinct from the lead payload version. */
  form_version: string | null;
  applied_revision_id: string | null;
  last_lifecycle_install_id: string | null;
  /** Site text from the control panel; null = the template default. */
  brand_name: string | null;
  site_title: string | null;
  site_description: string | null;
  /** Google Ads drain route from the control panel; null = not routed (the drain skips the brand). */
  google_ads_account: string | null;
  google_conversion_action: string | null;
  adkit_project: string | null;
  /** listmonk list the mailing cron sends this brand's leads to; null = the tenant LISTMONK_LIST_MAP fallback. */
  listmonk_list_id: number | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------------------------
// mailing_outbox
// ---------------------------------------------------------------------------------------------

export const MAILING_OUTBOX_STATUSES = ["pending", "sent", "skipped", "dead"] as const;
export type MailingOutboxStatus = (typeof MAILING_OUTBOX_STATUSES)[number];

export interface MailingOutboxRow {
  id: number;
  lead_id: string;
  brand: string;
  status: MailingOutboxStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  listmonk_subscriber_id: number | null;
  created_at: string;
  updated_at: string | null;
  sent_at: string | null;
}

// ---------------------------------------------------------------------------------------------
// A/B + keyword attribution columns added to click_sessions and leads (migration 0003).
// ---------------------------------------------------------------------------------------------

export interface ExperimentAttribution {
  experiment_id: string | null;
  variant: string | null;
  keyword: string | null;
}
