import {
  ADMIN_ERROR_STATUS,
  AlertsQuery,
  AlertsReportResponse,
  AuditQuery,
  BrandId,
  ConversionsQuery,
  FunnelQuery,
  TrafficBreakdownQuery,
  TrafficReportQuery, // spec traffic
  ClientErrorsQuery, // spec traffic
  FunnelReportResponse,
  MailingStatusResponse,
  SpendQuery,
  TrafficRiskExportQuery,
  TrafficRiskQuery,
  BrandPatchRequest,
  BrandStatusChangeRequest,
  LeadAggregatesQuery,
  LEAD_AGGREGATES_MAX_DAYS,
  LEAD_EXPORT_COLUMNS,
  LEAD_EXPORT_PII_COLUMNS,
  LeadConversion,
  LeadCursorKey,
  LeadExportQuery,
  LeadId,
  LeadsQuery,
  SuppressionsQuery,
  adminContextFromHeaders,
  authorize,
  leadOutcome,
  matchAdminRoute,
  type AbConfig,
  type AdminError,
  type AdminRequestContext,
  type AuditEntry,
  type BrandConfig,
  type BrandPatchField,
  type BrandPatchResponse,
  type BrandStatus,
  type BrandStatusChangeResponse,
  type LeadAggregateRow,
  type LeadApplicant,
  type LeadDetail,
  type LeadExportResponse,
  type LeadExportRow,
  type LeadListRow,
  type LeadsResponse,
  type SuppressionsResponse,
} from "@anjuna/contracts";
import type { Env } from "../env.js";
import { json } from "../http.js";
import { globalPostbackDigest } from "../postback-token.js";
import { parseStoredTheme } from "../rpc/runtime.js";
import { loadConversions } from "./conversions-report.js";
import { loadAlerts, loadFunnel, loadMailingStatus } from "./reports.js";
import { loadSpendReport } from "../spend.js";
import { loadTrafficRisk, loadTrafficRiskExport } from "./traffic-risk.js";

import { loadTrafficBreakdown } from "./traffic.js";
import { loadTrafficReport } from "./traffic-log.js"; // spec traffic
import { loadClientErrors } from "./client-errors.js"; // spec traffic

const JSON_BODY_LIMIT = 32 * 1024;

interface BrandRow {
  brand_id: string;
  account: string;
  hostnames: string;
  drain_key: string;
  postback_token_hash: string | null;
  aid: string;
  prepop_base: string;
  amount_buckets: string;
  flow_gate_mode: string;
  paused: number;
  ab_config_json: string | null;
  keyword_default: string | null;
  brand_name: string | null;
  site_title: string | null;
  site_description: string | null;
  theme_json: string | null;
  google_ads_account: string | null;
  google_conversion_action: string | null;
  adkit_project: string | null;
  created_at: string;
  updated_at: string;
  form_version?: string | null;
}

interface BrandStatsRow extends BrandRow {
  leads_7d: number;
  sold_7d: number;
  pending_7d: number;
}

interface LeadRow {
  lead_id: string;
  brand: string;
  hostname: string;
  status: string;
  form_version: string;
  form_variant: string;
  experiment_id: string | null;
  variant: string | null;
  keyword: string | null;
  requested_amount: number;
  loan_purpose: string;
  first_name: string;
  last_name: string;
  birth_date: string;
  email: string;
  home_phone: string;
  work_phone: string | null;
  address: string;
  city: string;
  state: string;
  zip: string;
  address_length_months: number;
  own_home: number;
  income_type: string;
  employer: string;
  job_title: string;
  employed_months: number;
  pay_date1: string;
  pay_frequency: string;
  direct_deposit: number;
  monthly_income: number;
  created_at: string;
  updated_at: string | null;
}

interface AuditRow {
  id: number;
  actor_id: string;
  actor_role: "owner" | "employee" | "system";
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

interface ParseSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

type JsonRecord = Record<string, unknown>;

function adminError(
  context: AdminRequestContext | null,
  error: AdminError,
): Response {
  const body = context ? { ...error, request_id: context.request_id } : error;
  return json(body, ADMIN_ERROR_STATUS[error.error]);
}

function invalid(
  context: AdminRequestContext,
  issues: Array<{ path: string; message: string }>,
): Response {
  return adminError(context, { error: "invalid", issues });
}

function schemaIssues(issues: Array<{ path: PropertyKey[]; message: string }>) {
  return issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "body",
    message: issue.message,
  }));
}

function parseWith<T>(
  schema: ParseSchema<T>,
  value: unknown,
  context: AdminRequestContext,
): T | Response {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : invalid(context, schemaIssues(parsed.error.issues));
}

async function readJsonObject(
  request: Request,
  context: AdminRequestContext,
): Promise<JsonRecord | Response> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > JSON_BODY_LIMIT) {
    return invalid(context, [{ path: "body", message: "Request body is too large" }]);
  }

  const text = await request.text();
  if (text.length > JSON_BODY_LIMIT) {
    return invalid(context, [{ path: "body", message: "Request body is too large" }]);
  }
  if (text.trim() === "") return {};

  try {
    const value: unknown = JSON.parse(text);
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      return invalid(context, [{ path: "body", message: "Expected an object" }]);
    }
    return value as JsonRecord;
  } catch {
    return invalid(context, [{ path: "body", message: "Invalid JSON" }]);
  }
}

function parseQuery(url: URL): JsonRecord {
  return Object.fromEntries(url.searchParams);
}

function nextTimestamp(previous: string): string {
  const previousMs = Date.parse(previous);
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
}

function lowercaseAbConfig(value: unknown): AbConfig | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid ab_config_json in brand_runtime");
  }
  const config = value as { experiment_id?: unknown; variants?: unknown };
  if (!Array.isArray(config.variants)) throw new Error("Invalid ab_config_json in brand_runtime");
  return {
    experiment_id: String(config.experiment_id),
    variants: config.variants.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Invalid ab_config_json in brand_runtime");
      }
      const variant = item as { id?: unknown; weight?: unknown };
      return { id: String(variant.id).toLowerCase(), weight: Number(variant.weight) };
    }),
  };
}

function parseJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

function brandConfig(row: BrandRow, globalPostback = false): BrandConfig {
  return {
    brand_id: row.brand_id,
    account: row.account,
    hostnames: parseJson(row.hostnames) as string[],
    status: row.paused === 1 ? "paused" : "live",
    form_version: row.form_version ?? null,
    keyword_default: row.keyword_default,
    brand_name: row.brand_name,
    site_title: row.site_title,
    site_description: row.site_description,
    theme: parseStoredTheme(row.theme_json),
    amount_buckets: parseJson(row.amount_buckets) as number[],
    ab_config: lowercaseAbConfig(parseJson(row.ab_config_json)),
    flow_gate_mode: row.flow_gate_mode as BrandConfig["flow_gate_mode"],
    aid: row.aid,
    prepop_base: row.prepop_base,
    drain_key: row.drain_key,
    google_ads_account: row.google_ads_account,
    google_conversion_action: row.google_conversion_action,
    adkit_project: row.adkit_project,
    postback_token: row.postback_token_hash ? "set" : globalPostback ? "global" : "not_set",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function brandRuntimeHasFormVersion(db: D1Database): Promise<boolean> {
  const columns = await db.prepare("PRAGMA table_info(brand_runtime)").all<{ name: string }>();
  return columns.results.some((column) => column.name === "form_version");
}

function brandColumns(includeFormVersion: boolean, table = ""): string {
  const prefix = table ? `${table}.` : "";
  const columns = [
    "brand_id", "account", "hostnames", "drain_key", "postback_token_hash", "aid",
    "prepop_base", "amount_buckets", "flow_gate_mode", "paused", "ab_config_json",
    "keyword_default", "brand_name", "site_title", "site_description", "theme_json",
    "google_ads_account", "google_conversion_action", "adkit_project", "created_at", "updated_at",
    ...(includeFormVersion ? ["form_version"] : []),
  ];
  return columns.map((column) => `${prefix}${column} AS ${column}`).join(", ");
}

async function getBrandRow(db: D1Database, brandId: string): Promise<BrandRow | null> {
  const includeFormVersion = await brandRuntimeHasFormVersion(db);
  return db.prepare(`SELECT ${brandColumns(includeFormVersion)} FROM brand_runtime WHERE brand_id = ?1`)
    .bind(brandId).first<BrandRow>();
}

async function writeAudit(
  env: Env,
  context: AdminRequestContext,
  action:
    | "brand.update" | "brand.pause" | "brand.resume"
    | "pii.lead_view" | "pii.lead_export" | "lead.export" | "pii.suppression_search",
  entityType: "brand" | "lead" | "lead_export" | "suppression",
  entityId: string,
  oldValue: JsonRecord | null,
  newValue: JsonRecord,
  at: string,
): Promise<number> {
  const result = await env.FACTORY.prepare(
    `INSERT INTO audit_log
      (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    context.actor_id,
    context.actor_role,
    action,
    entityType,
    entityId,
    oldValue === null ? null : JSON.stringify(oldValue),
    JSON.stringify(newValue),
    at,
  ).run();
  return result.meta.last_row_id;
}

async function listBrands(env: Env): Promise<Response> {
  const generatedAt = new Date().toISOString();
  const threshold = new Date(Date.parse(generatedAt) - 7 * 86_400_000).toISOString();
  const includeFormVersion = await brandRuntimeHasFormVersion(env.LEADS);
  const rows = await env.LEADS.prepare(
    `SELECT ${brandColumns(includeFormVersion, "br")},
       COUNT(l.lead_id) AS leads_7d,
       SUM(CASE WHEN l.status = 'soldLead' THEN 1 ELSE 0 END) AS sold_7d,
       SUM(CASE WHEN l.status NOT IN ('soldLead', 'rejectLead') THEN 1 ELSE 0 END) AS pending_7d
     FROM brand_runtime br
     LEFT JOIN leads l ON l.brand = br.brand_id AND julianday(l.created_at) >= julianday(?1)
     GROUP BY br.brand_id
     ORDER BY br.brand_id`,
  ).bind(threshold).all<BrandStatsRow>();

  return json({
    brands: rows.results.map((row) => {
      const config = brandConfig(row);
      return {
        brand_id: config.brand_id,
        hostnames: config.hostnames,
        status: config.status,
        flow_gate_mode: config.flow_gate_mode,
        ab_config: config.ab_config,
        form_version: config.form_version,
        stats_7d: {
          leads: Number(row.leads_7d),
          sold: Number(row.sold_7d),
          pending: Number(row.pending_7d),
        },
      };
    }),
    generated_at: generatedAt,
  });
}

async function getBrand(
  env: Env,
  context: AdminRequestContext,
  brandId: string,
): Promise<Response> {
  const row = await getBrandRow(env.LEADS, brandId);
  if (!row) return adminError(context, { error: "not_found", resource: "brand" });
  const globalPostback = (await globalPostbackDigest(env)) !== null;
  return json({ brand: brandConfig(row, globalPostback) });
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function randomPostbackToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function patchBrand(
  request: Request,
  env: Env,
  context: AdminRequestContext,
  brandId: string,
): Promise<Response> {
  const raw = await readJsonObject(request, context);
  if (raw instanceof Response) return raw;

  const permission = authorize("patchBrand", context.actor_role, raw);
  if (!permission.ok) return adminError(context, permission.error);

  const patch = parseWith(BrandPatchRequest, raw, context);
  if (patch instanceof Response) return patch;

  const row = await getBrandRow(env.LEADS, brandId);
  if (!row) return adminError(context, { error: "not_found", resource: "brand" });
  const globalPostback = (await globalPostbackDigest(env)) !== null;
  const before = brandConfig(row, globalPostback);
  if (patch.expected_updated_at !== undefined && patch.expected_updated_at !== row.updated_at) {
    return adminError(context, {
      error: "conflict",
      message: "Brand changed since it was loaded",
      current_updated_at: row.updated_at,
    });
  }

  const changes: Array<{ field: BrandPatchField; column: string; stored: unknown; old: unknown; next: unknown }> = [];
  const candidates: Array<[BrandPatchField, string, unknown, unknown, unknown]> = [
    ["keyword_default", "keyword_default", patch.keyword_default, before.keyword_default, patch.keyword_default],
    ["brand_name", "brand_name", patch.brand_name, before.brand_name, patch.brand_name],
    ["site_title", "site_title", patch.site_title, before.site_title, patch.site_title],
    ["site_description", "site_description", patch.site_description, before.site_description, patch.site_description],
    ["amount_buckets", "amount_buckets", patch.amount_buckets, before.amount_buckets,
      patch.amount_buckets === undefined ? undefined : JSON.stringify(patch.amount_buckets)],
    ["ab_config", "ab_config_json", patch.ab_config, before.ab_config,
      patch.ab_config === undefined ? undefined : patch.ab_config === null ? null : JSON.stringify(patch.ab_config)],
    ["flow_gate_mode", "flow_gate_mode", patch.flow_gate_mode, before.flow_gate_mode, patch.flow_gate_mode],
    ["aid", "aid", patch.aid, before.aid, patch.aid],
    ["prepop_base", "prepop_base", patch.prepop_base, before.prepop_base, patch.prepop_base],
    ["drain_key", "drain_key", patch.drain_key, before.drain_key, patch.drain_key],
    ["google_ads_account", "google_ads_account", patch.google_ads_account, before.google_ads_account, patch.google_ads_account],
    ["google_conversion_action", "google_conversion_action", patch.google_conversion_action,
      before.google_conversion_action, patch.google_conversion_action],
    ["adkit_project", "adkit_project", patch.adkit_project, before.adkit_project, patch.adkit_project],
    ["theme", "theme_json", patch.theme, before.theme,
      patch.theme === undefined ? undefined : patch.theme === null ? null : JSON.stringify(patch.theme)],
  ];
  for (const [field, column, requested, old, stored] of candidates) {
    // An invalid stored theme_json reads as null; clearing it still has to write NULL.
    const clearsStoredTheme = field === "theme" && requested === null && row.theme_json !== null;
    if (requested !== undefined && (clearsStoredTheme || !equalJson(requested, old))) {
      const auditOld = clearsStoredTheme && old === null && row.theme_json !== null ? row.theme_json : old;
      changes.push({ field, column, stored, old: auditOld, next: requested });
    }
  }

  let issuedPostbackToken: string | undefined;
  if (patch.rotate_postback_token === true) {
    issuedPostbackToken = randomPostbackToken();
    changes.push({
      field: "rotate_postback_token",
      column: "postback_token_hash",
      stored: await sha256Hex(issuedPostbackToken),
      old: before.postback_token,
      next: "set",
    });
  }

  if (changes.length === 0) {
    const response: BrandPatchResponse = { brand: before, changed: [], audit_id: null };
    return json(response);
  }

  const updatedAt = nextTimestamp(row.updated_at);
  const assignments = changes.map((change, index) => `${change.column} = ?${index + 1}`);
  assignments.push(`updated_at = ?${changes.length + 1}`);
  const update = await env.LEADS.prepare(
    `UPDATE brand_runtime SET ${assignments.join(", ")}
     WHERE brand_id = ?${changes.length + 2} AND updated_at = ?${changes.length + 3}`,
  ).bind(
    ...changes.map((change) => change.stored),
    updatedAt,
    brandId,
    row.updated_at,
  ).run();
  if (update.meta.changes !== 1) {
    const current = await getBrandRow(env.LEADS, brandId);
    if (!current) return adminError(context, { error: "not_found", resource: "brand" });
    return adminError(context, {
      error: "conflict",
      message: "Brand changed since it was loaded",
      current_updated_at: current.updated_at,
    });
  }

  const oldValue: JsonRecord = {};
  const newValue: JsonRecord = {};
  for (const change of changes) {
    if (change.field === "rotate_postback_token") {
      oldValue.postback_token = change.old;
      newValue.postback_token = "set";
      newValue.postback_token_rotated = true;
    } else {
      oldValue[change.field] = change.old;
      newValue[change.field] = change.next;
    }
  }
  const auditId = await writeAudit(env, context, "brand.update", "brand", brandId, oldValue, newValue, updatedAt);
  const updated = await getBrandRow(env.LEADS, brandId);
  if (!updated) throw new Error("Updated brand disappeared");

  const response: BrandPatchResponse = {
    brand: brandConfig(updated, globalPostback),
    changed: changes.map((change) => change.field),
    audit_id: auditId,
    ...(issuedPostbackToken ? { issued_postback_token: issuedPostbackToken } : {}),
  };
  return json(response);
}

async function changeBrandStatus(
  request: Request,
  env: Env,
  context: AdminRequestContext,
  brandId: string,
  status: BrandStatus,
): Promise<Response> {
  const body = await readJsonObject(request, context);
  if (body instanceof Response) return body;
  const parsed = parseWith(BrandStatusChangeRequest, body, context);
  if (parsed instanceof Response) return parsed;

  const row = await getBrandRow(env.LEADS, brandId);
  if (!row) return adminError(context, { error: "not_found", resource: "brand" });
  const current: BrandStatus = row.paused === 1 ? "paused" : "live";
  if (current === status) {
    const response: BrandStatusChangeResponse = { brand_id: brandId, status, changed: false, audit_id: null };
    return json(response);
  }

  const updatedAt = nextTimestamp(row.updated_at);
  const update = await env.LEADS.prepare(
    "UPDATE brand_runtime SET paused = ?1, updated_at = ?2 WHERE brand_id = ?3 AND paused = ?4",
  ).bind(status === "paused" ? 1 : 0, updatedAt, brandId, row.paused).run();
  if (update.meta.changes !== 1) {
    const currentRow = await getBrandRow(env.LEADS, brandId);
    if (!currentRow) return adminError(context, { error: "not_found", resource: "brand" });
    const currentStatus: BrandStatus = currentRow.paused === 1 ? "paused" : "live";
    if (currentStatus === status) {
      return json({ brand_id: brandId, status, changed: false, audit_id: null });
    }
    return adminError(context, {
      error: "conflict",
      message: "Brand changed since it was loaded",
      current_updated_at: currentRow.updated_at,
    });
  }

  const action = status === "paused" ? "brand.pause" : "brand.resume";
  const newValue: JsonRecord = { status };
  if (parsed.reason !== undefined) newValue.reason = parsed.reason;
  const auditId = await writeAudit(env, context, action, "brand", brandId, { status: current }, newValue, updatedAt);
  const response: BrandStatusChangeResponse = { brand_id: brandId, status, changed: true, audit_id: auditId };
  return json(response);
}

async function leadAggregates(
  url: URL,
  env: Env,
  context: AdminRequestContext,
): Promise<Response> {
  const query = parseWith(LeadAggregatesQuery, parseQuery(url), context);
  if (query instanceof Response) return query;

  const toExclusive = new Date(`${query.to}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const brandFilter = query.brand_id === undefined ? "" : "AND brand = ?3";
  const bindings: unknown[] = [
    `${query.from}T00:00:00.000Z`,
    toExclusive.toISOString(),
    ...(query.brand_id === undefined ? [] : [query.brand_id]),
  ];
  const rows = await env.LEADS.prepare(
    `SELECT brand AS brand_id, substr(created_at, 1, 10) AS day,
       CASE WHEN status = 'soldLead' THEN 'sold'
            WHEN status = 'rejectLead' THEN 'rejected'
            ELSE 'pending' END AS outcome,
       COUNT(*) AS count
     FROM leads
     WHERE julianday(created_at) >= julianday(?1) AND julianday(created_at) < julianday(?2)
       ${brandFilter}
     GROUP BY brand, substr(created_at, 1, 10), outcome
     ORDER BY brand, day,
       CASE outcome WHEN 'pending' THEN 0 WHEN 'sold' THEN 1 ELSE 2 END`,
  ).bind(...bindings).all<{ brand_id: string; day: string; outcome: string; count: number }>();

  const responseRows: LeadAggregateRow[] = rows.results.map((row) => ({
    brand_id: row.brand_id,
    day: row.day,
    status: row.outcome as LeadAggregateRow["status"],
    count: Number(row.count),
  }));
  return json({ from: query.from, to: query.to, timezone: "UTC", rows: responseRows });
}

async function getLead(
  env: Env,
  context: AdminRequestContext,
  leadId: string,
): Promise<Response> {
  const isOwner = context.actor_role === "owner";
  const row = await env.LEADS.prepare("SELECT * FROM leads WHERE lead_id = ?1").bind(leadId).first<LeadRow>();
  if (!row) return adminError(context, { error: "not_found", resource: "lead" });
  const postbacks = await env.LEADS.prepare(
    "SELECT event_type, payout, created_at FROM postback_events WHERE lead_id = ?1 ORDER BY created_at, id",
  ).bind(leadId).all<{ event_type: string; payout: number; created_at: string }>();
  const upload = await loadLeadConversion(env, leadId);
  const applicant: LeadApplicant | null = isOwner
    ? {
      first_name: row.first_name,
      last_name: row.last_name,
      birth_date: row.birth_date,
      email: row.email,
      home_phone: row.home_phone,
      work_phone: row.work_phone,
      address: row.address,
      city: row.city,
      state: row.state,
      zip: row.zip,
      address_length_months: Number(row.address_length_months),
      own_home: row.own_home === 1,
      income_type: row.income_type,
      employer: row.employer,
      job_title: row.job_title,
      employed_months: Number(row.employed_months),
      pay_date1: row.pay_date1,
      pay_frequency: row.pay_frequency,
      direct_deposit: row.direct_deposit === 1,
      monthly_income: Number(row.monthly_income),
    }
    : null;
  const detail: LeadDetail = {
    lead_id: row.lead_id,
    brand_id: row.brand,
    hostname: row.hostname,
    status: row.status,
    outcome: leadOutcome(row.status),
    form_version: row.form_version,
    form_variant: row.form_variant,
    experiment_id: row.experiment_id,
    variant: row.variant?.toLowerCase() ?? null,
    keyword: row.keyword,
    requested_amount: Number(row.requested_amount),
    loan_purpose: row.loan_purpose,
    applicant,
    profile: {
      state: row.state,
      address_length_months: Number(row.address_length_months),
      own_home: row.own_home === 1,
      income_type: row.income_type,
      employer: row.employer,
      job_title: row.job_title,
      employed_months: Number(row.employed_months),
      pay_date1: row.pay_date1,
      pay_frequency: row.pay_frequency,
      direct_deposit: row.direct_deposit === 1,
      monthly_income: Number(row.monthly_income),
    },
    postbacks: postbacks.results.map((event) => ({
      event_type: event.event_type,
      payout: isOwner ? Number(event.payout) : null,
      created_at: event.created_at,
    })),
    conversion: upload === null ? null : {
      status: conversionStatus(upload.status),
      click_type: upload.click_type,
      currency: upload.currency,
      occurred_at: upload.occurred_at,
      attempts: Number(upload.attempts),
      next_attempt_at: upload.next_attempt_at,
      created_at: upload.created_at,
      updated_at: upload.updated_at,
      value: isOwner ? Number(upload.value) : null,
      // The drain stores its raw error; the contract caps it at 300 and the panel rejects the whole page past that.
      last_error: isOwner ? (upload.last_error?.slice(0, 300) ?? null) : null,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  // Fails closed: no try/catch, so an audit insert that throws keeps the PII body unsent. The throw
  // crosses the service binding as a rejected fetch, not a 500, and the panel's callCore maps that to
  // 502 bad_gateway, so core has no status code of its own to assert for this path.
  if (applicant !== null) {
    await writeAudit(env, context, "pii.lead_view", "lead", leadId, null, { fields: PII_LEAD_FIELDS }, new Date().toISOString());
  }
  return json({ lead: detail });
}

// spec leads
/** Names of the lead columns that are PII. An audit row records these names, never the values. */
export const PII_LEAD_FIELDS = [
  "first_name", "last_name", "birth_date", "email", "home_phone", "work_phone", "address", "city", "zip",
] as const satisfies ReadonlyArray<keyof LeadApplicant>;

/** `conversion_uploads.status` is free text the drain writes; anything unknown reads as pending. */
function conversionStatus(raw: string): LeadConversion["status"] {
  const parsed = LeadConversion.shape.status.safeParse(raw);
  return parsed.success ? parsed.data : "pending";
}

interface LeadConversionSqlRow {
  status: string;
  click_type: LeadConversion["click_type"];
  value: number;
  currency: string;
  occurred_at: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string | null;
}

/** Click id values stay in D1: the query returns only which column is set. */
async function loadLeadConversion(env: Env, leadId: string): Promise<LeadConversionSqlRow | null> {
  return env.LEADS.prepare(
    `SELECT status,
       CASE WHEN gclid IS NOT NULL THEN 'gclid'
            WHEN gbraid IS NOT NULL THEN 'gbraid'
            WHEN wbraid IS NOT NULL THEN 'wbraid'
            WHEN msclkid IS NOT NULL THEN 'msclkid'
            ELSE 'none' END AS click_type,
       value, currency, occurred_at, attempts, last_error, next_attempt_at, created_at, updated_at
     FROM conversion_uploads WHERE lead_id = ?1`,
  ).bind(leadId).first<LeadConversionSqlRow>();
}

/** `base64url("<created_at>|<lead_id>")`. Leads page on `(created_at DESC, lead_id DESC)`. */
export function encodeLeadCursor(createdAt: string, leadId: string): string {
  return btoa(`${createdAt}|${leadId}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeLeadCursor(cursor: string): { created_at: string; lead_id: string } | null {
  try {
    const text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const separator = text.indexOf("|");
    if (separator < 0) return null;
    // A malformed timestamp would reach SQL as a string comparison and return a wrong page, not an error.
    const parsed = LeadCursorKey.safeParse({
      created_at: text.slice(0, separator),
      lead_id: text.slice(separator + 1),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Escapes `%`, `_` and `\` for a `LIKE ... ESCAPE '\'` pattern so user input cannot widen a match. */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** UTC calendar days, `YYYY-MM-DD`, both inclusive. */
export interface LeadWindow {
  from: string;
  to: string;
}

/**
 * Fills a missing bound so no request scans unbounded history: `to` defaults to today and `from`
 * to 29 days before `to` (a 30-day span). Then it applies the same two refusals the query schemas
 * apply, to the resolved pair, because the schemas cannot see a defaulted bound. Callers read
 * `from` and `to` from the result (the audit target id of an export, for one) and pass the result
 * to `leadFilterSql`, so the default is computed once per request.
 */
export function resolveLeadWindow(
  query: Pick<LeadsQuery, "from" | "to">,
  now: Date = new Date(),
): LeadWindow | { issue: { path: string; message: string } } {
  const to = query.to ?? now.toISOString().slice(0, 10);
  const from = query.from ?? new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (from > to) return { issue: { path: "from", message: "from must not be after to" } };
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > LEAD_AGGREGATES_MAX_DAYS) {
    return { issue: { path: "from", message: `Window is longer than ${LEAD_AGGREGATES_MAX_DAYS} days` } };
  }
  return { from, to };
}

/**
 * `WHERE` body (without the word) shared by the lead list and the lead export. Columns are
 * qualified with the alias `l`. Pushes its binds onto `bindings`; each placeholder is taken from
 * the bind it pushes, so indexes cannot drift. Holds no cursor and no limit.
 */
export function leadFilterSql(
  query: LeadsQuery | LeadExportQuery,
  window: LeadWindow,
  bindings: unknown[],
): string {
  const add = (value: unknown): string => {
    bindings.push(value);
    return `?${bindings.length}`;
  };
  const toExclusive = new Date(`${window.to}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const clauses: string[] = [
    `julianday(l.created_at) >= julianday(${add(`${window.from}T00:00:00.000Z`)})`,
    `julianday(l.created_at) < julianday(${add(toExclusive.toISOString())})`,
  ];
  if (query.brand !== undefined) clauses.push(`l.brand = ${add(query.brand)}`);
  if (query.status === "sold") clauses.push("l.status = 'soldLead'");
  else if (query.status === "rejected") clauses.push("l.status = 'rejectLead'");
  else if (query.status === "pending") clauses.push("l.status NOT IN ('soldLead', 'rejectLead')");
  if (query.q !== undefined) {
    const prefix = add(`${likeEscape(query.q)}%`);
    clauses.push(`(l.lead_id LIKE ${prefix} ESCAPE '\\' OR l.click_id = ${add(query.q)})`);
  }
  return clauses.join(" AND ");
}

interface LeadListSqlRow {
  lead_id: string;
  brand: string;
  hostname: string;
  status: string;
  requested_amount: number;
  loan_purpose: string;
  state: string;
  keyword: string | null;
  variant: string | null;
  form_variant: string;
  created_at: string;
  has_conversion: number;
  postback_count: number;
}

function leadListRow(row: LeadListSqlRow): LeadListRow {
  return {
    lead_id: row.lead_id,
    brand: row.brand,
    hostname: row.hostname,
    status: row.status,
    outcome: leadOutcome(row.status),
    requested_amount: Number(row.requested_amount),
    loan_purpose: row.loan_purpose,
    state: row.state,
    keyword: row.keyword,
    variant: row.variant?.toLowerCase() ?? null,
    form_variant: row.form_variant,
    has_conversion: Number(row.has_conversion) === 1,
    postback_count: Number(row.postback_count),
    created_at: row.created_at,
  };
}

async function listLeads(url: URL, env: Env, context: AdminRequestContext): Promise<Response> {
  const query = parseWith(LeadsQuery, parseQuery(url), context);
  if (query instanceof Response) return query;

  const cursor = query.cursor === undefined ? null : decodeLeadCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) {
    return invalid(context, [{ path: "cursor", message: "Invalid cursor" }]);
  }

  const window = resolveLeadWindow(query);
  if ("issue" in window) return invalid(context, [window.issue]);

  const bindings: unknown[] = [];
  const clauses = [leadFilterSql(query, window, bindings)];
  if (cursor !== null) {
    bindings.push(cursor.created_at, cursor.lead_id);
    const at = bindings.length - 1;
    const id = bindings.length;
    clauses.push(`(l.created_at < ?${at} OR (l.created_at = ?${at} AND l.lead_id < ?${id}))`);
  }
  const limit = query.limit ?? 50;
  bindings.push(limit + 1);

  const result = await env.LEADS.prepare(
    `SELECT l.lead_id, l.brand, l.hostname, l.status, l.requested_amount, l.loan_purpose,
       l.state, l.keyword, l.variant, l.form_variant, l.created_at,
       EXISTS (SELECT 1 FROM conversion_uploads c WHERE c.lead_id = l.lead_id) AS has_conversion,
       (SELECT COUNT(*) FROM postback_events p WHERE p.lead_id = l.lead_id) AS postback_count
     FROM leads l
     WHERE ${clauses.join(" AND ")}
     ORDER BY l.created_at DESC, l.lead_id DESC
     LIMIT ?${bindings.length}`,
  ).bind(...bindings).all<LeadListSqlRow>();

  const page = result.results.slice(0, limit);
  const last = page[page.length - 1];
  const response: LeadsResponse = {
    rows: page.map(leadListRow),
    next_cursor: result.results.length > limit && last ? encodeLeadCursor(last.created_at, last.lead_id) : null,
  };
  return json(response);
}

type LeadExportSqlRow = LeadListSqlRow & Partial<LeadRow>;

/** PII columns as `leads` names them, in contract order. Selected only for an owner who asked for them. */
const LEAD_EXPORT_PII_SQL = LEAD_EXPORT_PII_COLUMNS.slice(LEAD_EXPORT_COLUMNS.length).map((column) => `l.${column}`);

function leadExportPiiFields(row: LeadExportSqlRow): Partial<LeadExportRow> {
  return {
    first_name: row.first_name,
    last_name: row.last_name,
    birth_date: row.birth_date,
    email: row.email,
    home_phone: row.home_phone,
    work_phone: row.work_phone ?? null,
    address: row.address,
    city: row.city,
    zip: row.zip,
    address_length_months: Number(row.address_length_months),
    own_home: row.own_home === 1,
    income_type: row.income_type,
    employer: row.employer,
    job_title: row.job_title,
    employed_months: Number(row.employed_months),
    pay_date1: row.pay_date1,
    pay_frequency: row.pay_frequency,
    direct_deposit: row.direct_deposit === 1,
    monthly_income: Number(row.monthly_income),
  };
}

async function leadExport(url: URL, env: Env, context: AdminRequestContext): Promise<Response> {
  const query = parseWith(LeadExportQuery, parseQuery(url), context);
  if (query instanceof Response) return query;

  const window = resolveLeadWindow(query);
  if ("issue" in window) return invalid(context, [window.issue]);

  const permission = authorize("leadExport", context.actor_role, { pii: query.pii === "1" });
  if (!permission.ok) return adminError(context, permission.error);
  const pii = query.pii === "1" && context.actor_role === "owner";

  const bindings: unknown[] = [];
  const where = leadFilterSql(query, window, bindings);
  bindings.push(query.limit + 1);
  const result = await env.LEADS.prepare(
    `SELECT l.lead_id, l.brand, l.hostname, l.status, l.requested_amount, l.loan_purpose,
       l.state, l.keyword, l.variant, l.form_variant, l.created_at,
       EXISTS (SELECT 1 FROM conversion_uploads c WHERE c.lead_id = l.lead_id) AS has_conversion,
       (SELECT COUNT(*) FROM postback_events p WHERE p.lead_id = l.lead_id) AS postback_count
       ${pii ? `, ${LEAD_EXPORT_PII_SQL.join(", ")}` : ""}
     FROM leads l
     WHERE ${where}
     ORDER BY l.created_at DESC, l.lead_id DESC
     LIMIT ?${bindings.length}`,
  ).bind(...bindings).all<LeadExportSqlRow>();

  const truncated = result.results.length > query.limit;
  const rows = result.results.slice(0, query.limit).map((row): LeadExportRow => ({
    ...leadListRow(row),
    ...(pii ? leadExportPiiFields(row) : {}),
  }));
  // Fails closed, as getLead does: no try/catch, so an export whose audit insert throws is never sent.
  // The row holds counts and the resolved filters, never a value from the rows.
  await writeAudit(
    env,
    context,
    pii ? "pii.lead_export" : "lead.export",
    "lead_export",
    `${window.from}..${window.to}:${query.brand ?? "all"}`,
    null,
    {
      rows: rows.length,
      truncated,
      pii,
      filters: {
        brand: query.brand ?? null,
        from: window.from,
        to: window.to,
        status: query.status ?? null,
        q: query.q ?? null,
      },
    },
    new Date().toISOString(),
  );
  const response: LeadExportResponse = { rows, truncated, pii };
  return json(response);
}

/** `base64url(email)`. Suppressions page on `email ASC`, their primary key. */
function encodeSuppressionCursor(email: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(email)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A cursor must decode to something a stored address can be: non-empty, at most 254 characters, valid UTF-8, no whitespace or control characters. */
function decodeSuppressionCursor(cursor: string): string | null {
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const email = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return email.length >= 1 && email.length <= 254 && !/[\s\p{Cc}]/u.test(email) ? email : null;
  } catch {
    return null;
  }
}

interface SuppressionSqlRow {
  email: string;
  reason: string;
  source: string;
  created_at: string;
  updated_at: string | null;
}

/** Owner-only at the endpoint table: every row is an email address, so there is no non-PII view. */
async function listSuppressions(url: URL, env: Env, context: AdminRequestContext): Promise<Response> {
  const query = parseWith(SuppressionsQuery, parseQuery(url), context);
  if (query instanceof Response) return query;

  const cursor = query.cursor === undefined ? null : decodeSuppressionCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) {
    return invalid(context, [{ path: "cursor", message: "Invalid cursor" }]);
  }

  const bindings: unknown[] = [];
  const add = (value: unknown): string => {
    bindings.push(value);
    return `?${bindings.length}`;
  };
  const clauses: string[] = [];
  // `q` is not restricted by the schema, so `%`, `_` and `\` reach this pattern and must be escaped.
  if (query.q !== undefined) clauses.push(`email LIKE ${add(`%${likeEscape(query.q.toLowerCase())}%`)} ESCAPE '\\'`);
  if (query.reason !== undefined) clauses.push(`reason = ${add(query.reason)}`);
  if (query.source !== undefined) clauses.push(`source = ${add(query.source)}`);
  if (cursor !== null) clauses.push(`email > ${add(cursor)}`);
  const limit = query.limit ?? 50;

  const result = await env.LEADS.prepare(
    `SELECT email, reason, source, created_at, updated_at
     FROM suppressions
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY email ASC
     LIMIT ${add(limit + 1)}`,
  ).bind(...bindings).all<SuppressionSqlRow>();

  const page = result.results.slice(0, limit);
  const last = page[page.length - 1];
  // Fails closed, as getLead does: no try/catch. The row holds the actor's own query and a count, never an address from the rows.
  await writeAudit(
    env,
    context,
    "pii.suppression_search",
    "suppression",
    "search",
    null,
    { q: query.q ?? null, reason: query.reason ?? null, source: query.source ?? null, rows: page.length },
    new Date().toISOString(),
  );
  const response: SuppressionsResponse = {
    rows: page as SuppressionsResponse["rows"],
    next_cursor: result.results.length > limit && last ? encodeSuppressionCursor(last.email) : null,
  };
  return json(response);
}

function encodeCursor(id: number): string {
  return btoa(String(id)).replace(/=+$/, "");
}

function decodeCursor(cursor: string): number | null {
  try {
    const value = Number(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function auditEntry(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    actor_id: row.actor_id,
    actor_role: row.actor_role,
    action: row.action,
    target: { type: row.entity_type, id: row.entity_id },
    old: parseJson(row.before_json) as AuditEntry["old"],
    new: parseJson(row.after_json) as AuditEntry["new"],
    at: row.created_at,
  };
}

async function listAudit(
  url: URL,
  env: Env,
  context: AdminRequestContext,
  scope: "own" | "all",
): Promise<Response> {
  const query = parseWith(AuditQuery, parseQuery(url), context);
  if (query instanceof Response) return query;
  if (scope === "own" && query.actor_id !== undefined && query.actor_id !== context.actor_id) {
    return adminError(context, { error: "forbidden_role", required_role: "owner" });
  }

  const cursorId = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && cursorId === null) {
    return invalid(context, [{ path: "cursor", message: "Invalid cursor" }]);
  }

  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    clauses.push(`${sql} ?${values.length}`);
  };
  if (scope === "own") add("actor_id =", context.actor_id);
  else if (query.actor_id !== undefined) add("actor_id =", query.actor_id);
  if (query.target_type !== undefined) add("entity_type =", query.target_type);
  if (query.target_id !== undefined) add("entity_id =", query.target_id);
  if (cursorId !== null) add("id <", cursorId);
  const limit = query.limit ?? 50;
  values.push(limit + 1);

  const rows = await env.FACTORY.prepare(
    `SELECT id, actor_id, actor_role, action, entity_type, entity_id,
       before_json, after_json, created_at
     FROM audit_log
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY id DESC
     LIMIT ?${values.length}`,
  ).bind(...values).all<AuditRow>();
  const hasMore = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  return json({
    entries: page.map(auditEntry),
    next_cursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.id) : null,
  });
}

function routeParam(
  schema: ParseSchema<string>,
  value: string,
  path: string,
  context: AdminRequestContext,
): string | Response {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : invalid(context, schemaIssues(
    parsed.error.issues.map((issue) => ({ ...issue, path: [path, ...issue.path] })),
  ));
}

export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  const context = adminContextFromHeaders(request.headers);
  if (!context) return adminError(null, { error: "unauthorized" });

  let route: ReturnType<typeof matchAdminRoute>;
  try {
    route = matchAdminRoute(request.method, new URL(request.url).pathname);
  } catch {
    return adminError(context, { error: "not_found", resource: "route" });
  }
  if (!route) return adminError(context, { error: "not_found", resource: "route" });

  const endpointPermission = authorize(route.endpoint, context.actor_role);
  if (!endpointPermission.ok) return adminError(context, endpointPermission.error);

  if ("id" in route.params) {
    const brandId = routeParam(BrandId, route.params.id!, "brand_id", context);
    if (brandId instanceof Response) return brandId;
    if (route.endpoint === "getBrand") return getBrand(env, context, brandId);
    if (route.endpoint === "patchBrand") return patchBrand(request, env, context, brandId);
    if (route.endpoint === "pauseBrand") return changeBrandStatus(request, env, context, brandId, "paused");
    if (route.endpoint === "resumeBrand") return changeBrandStatus(request, env, context, brandId, "live");
  }

  // spec leads
  if (route.endpoint === "listLeads") return listLeads(new URL(request.url), env, context);
  if (route.endpoint === "leadExport") return leadExport(new URL(request.url), env, context);
  if (route.endpoint === "listSuppressions") return listSuppressions(new URL(request.url), env, context);

  if (route.endpoint === "listBrands") return listBrands(env);
  if (route.endpoint === "leadAggregates") return leadAggregates(new URL(request.url), env, context);
  if (route.endpoint === "getLead") {
    const leadId = routeParam(LeadId, route.params.lead_id!, "lead_id", context);
    return leadId instanceof Response ? leadId : getLead(env, context, leadId);
  }
  if (route.endpoint === "listAudit") {
    return listAudit(new URL(request.url), env, context, endpointPermission.scope);
  }
  if (route.endpoint === "trafficBreakdown") {
    const query = parseWith(TrafficBreakdownQuery, parseQuery(new URL(request.url)), context);
    if (query instanceof Response) return query;
    return json(await loadTrafficBreakdown(env, query));
  }
  if (route.endpoint === "funnelReport") {
    const filter = parseWith(FunnelQuery, parseQuery(new URL(request.url)), context);
    if (filter instanceof Response) return filter;
    return json(FunnelReportResponse.parse(await loadFunnel(env, filter, context.actor_role)));
  }
  if (route.endpoint === "alertsReport") {
    const query = parseWith(AlertsQuery, parseQuery(new URL(request.url)), context);
    if (query instanceof Response) return query;
    return json(AlertsReportResponse.parse(await loadAlerts(env, query)));
  }
  if (route.endpoint === "mailingStatus") {
    return json(MailingStatusResponse.parse(await loadMailingStatus(env)));
  }
  if (route.endpoint === "spendReport") {
    const query = parseWith(SpendQuery, parseQuery(new URL(request.url)), context);
    if (query instanceof Response) return query;
    return json(await loadSpendReport(env, query.period));
  }
  if (route.endpoint === "conversionsReport") {
    const query = parseWith(ConversionsQuery, parseQuery(new URL(request.url)), context);
    if (query instanceof Response) return query;
    return json(await loadConversions(env, query, context.actor_role));
  }
  if (route.endpoint === "trafficRisk") {
    const query = parseWith(TrafficRiskQuery, parseQuery(new URL(request.url)), context);
    if (query instanceof Response) return query;
    return json(await loadTrafficRisk(env, query.period));
  }
  if (route.endpoint === "trafficRiskExport") {
    // Owner only: authorize() above already answered 403 forbidden_role to an employee.
    const query = parseWith(TrafficRiskExportQuery, parseQuery(new URL(request.url)), context);
    if (query instanceof Response) return query;
    return json(await loadTrafficRiskExport(env, query));
  }
  // spec traffic
  if (route.endpoint === "trafficReport") {
    const query = parseWith(TrafficReportQuery, parseQuery(new URL(request.url)), context);
    if (query instanceof Response) return query;
    return json(await loadTrafficReport(env, query));
  }
  // spec traffic
  if (route.endpoint === "clientErrors") {
    const query = parseWith(ClientErrorsQuery, parseQuery(new URL(request.url)), context);
    if (query instanceof Response) return query;
    return json(await loadClientErrors(env, query, context.actor_role));
  }

  return adminError(context, { error: "not_found", resource: "route" });
}
