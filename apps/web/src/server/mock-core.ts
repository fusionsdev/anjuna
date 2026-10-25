/**
 * Mock core for T12a (switch: `MOCK_CORE=1`). Serves the admin API from the T12-0 fixtures and
 * applies the contract's check order, so the panel is built and tested against the same behaviour
 * the real core (T6) must have. State is in memory: it resets when the isolate restarts.
 * Remove once the panel runs against the CORE service binding.
 */
import {
  AdminApi,
  BRAND_PATCH_FIELDS,
  BrandConfig,
  BrandPatchRequest,
  BrandStatusChangeRequest,
  ConversionsQuery,
  LeadAggregatesQuery,
  AlertsQuery,
  AuditQuery,
  FunnelQuery,
  SpendQuery,
  TrafficRiskExportQuery,
  TrafficRiskQuery,
  LeadsQuery,
  LeadExportQuery,
  SuppressionsQuery,
  TrafficBreakdownQuery,
  trafficWindow,
  ClientErrorsQuery, // spec traffic
  TrafficReportQuery, // spec traffic
  trafficLogBuckets, // spec traffic
  trafficLogWindow, // spec traffic
  adminContextFromHeaders,
  authorize,
  employeeLastError,
  matchAdminRoute,
  type AdminError,
  type AdminRole,
  AuditEntry,
  type BrandPatchField,
} from "@anjuna/contracts";
import auditOwner from "@anjuna/contracts/fixtures/admin/audit.list.response.owner.json";
import brandA from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import lead from "@anjuna/contracts/fixtures/admin/lead.get.response.json";
import leadEmployee from "@anjuna/contracts/fixtures/admin/lead.get.response.employee.json";
import leadsList from "@anjuna/contracts/fixtures/admin/leads.list.response.json";
import leadsExport from "@anjuna/contracts/fixtures/admin/leads.export.response.json";
import leadsExportPii from "@anjuna/contracts/fixtures/admin/leads.export.response.pii.json";
import suppressionsList from "@anjuna/contracts/fixtures/admin/suppressions.list.response.json";
import aggregates from "@anjuna/contracts/fixtures/admin/leads.aggregates.response.json";
import alertsReport from "@anjuna/contracts/fixtures/admin/alerts.response.json";
import brandsList from "@anjuna/contracts/fixtures/admin/brands.list.response.json";
import conversionsReport from "@anjuna/contracts/fixtures/admin/conversions.response.json";
import funnelReport from "@anjuna/contracts/fixtures/admin/funnel.response.json";
import mailingStatus from "@anjuna/contracts/fixtures/admin/mailing.response.json";
import spendReport from "@anjuna/contracts/fixtures/admin/spend.response.json";
import trafficRisk from "@anjuna/contracts/fixtures/admin/traffic-risk.response.json";
import trafficRiskExport from "@anjuna/contracts/fixtures/admin/traffic-risk.export.response.json";
import trafficReport from "@anjuna/contracts/fixtures/admin/traffic-report.response.json";
import clientErrors from "@anjuna/contracts/fixtures/admin/client-errors.response.json";

interface State {
  brands: Map<string, BrandConfig>;
  audit: AuditEntry[];
  nextAuditId: number;
}

function initialState(): State {
  const a = BrandConfig.parse(brandA.brand);
  const bSummary = brandsList.brands.find((b) => b.brand_id === "brand-b")!;
  const b = BrandConfig.parse({
    brand_id: bSummary.brand_id,
    account: "side",
    hostnames: bSummary.hostnames,
    status: bSummary.status,
    form_version: bSummary.form_version,
    keyword_default: null,
    brand_name: null,
    site_title: null,
    site_description: null,
    amount_buckets: [500, 1000, 1500],
    ab_config: bSummary.ab_config,
    flow_gate_mode: bSummary.flow_gate_mode,
    aid: "10002",
    prepop_base: "https://prepop.example/apply",
    drain_key: "brand_b",
    google_ads_account: null,
    google_conversion_action: null,
    adkit_project: null,
    postback_token: "not_set",
    created_at: "2026-09-30T08:00:00.000Z",
    updated_at: "2026-10-01T09:30:00.000Z",
  });
  const audit = AuditEntry.array().parse(structuredClone(auditOwner.entries));
  return {
    brands: new Map([
      [a.brand_id, a],
      [b.brand_id, b],
    ]),
    audit,
    nextAuditId: Math.max(0, ...audit.map((e) => e.id)) + 1,
  };
}

let state = initialState();

/** Test helper: back to the fixture state. */
export function resetMockCore(): void {
  state = initialState();
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const err = (e: AdminError): Response => {
  const status = { unauthorized: 401, forbidden_role: 403, not_found: 404, conflict: 409, invalid: 422 }[e.error];
  return json(status, e);
};

function issues(e: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  return e.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function audit(actor_id: string, actor_role: AdminRole, action: string, brand_id: string, old: AuditEntry["old"], now: AuditEntry["new"]): number {
  const id = state.nextAuditId++;
  state.audit.push({
    id,
    actor_id,
    actor_role,
    action,
    target: { type: "brand", id: brand_id },
    old,
    new: now,
    at: new Date().toISOString(),
  });
  return id;
}

export async function mockCoreFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ctx = adminContextFromHeaders(request.headers);
  if (!ctx) return err({ error: "unauthorized" });
  const rid = ctx.request_id;

  const route = matchAdminRoute(request.method, url.pathname);
  if (!route) return err({ error: "not_found", resource: "route", request_id: rid });
  const { endpoint, params } = route;

  const raw: unknown = request.method === "GET" ? undefined : await request.json().catch(() => ({}));
  const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  // 2. endpoint role
  const gate = authorize(endpoint, ctx.actor_role);
  if (!gate.ok) return err({ ...gate.error, request_id: rid });

  // 3. validation
  let patch: BrandPatchRequest | undefined;
  let reason: string | undefined;
  let auditQuery: AuditQuery | undefined;
  let conversionsQuery: ConversionsQuery | undefined;
  // spec leads
  let leadsQuery: LeadsQuery | undefined;
  let leadExportQuery: LeadExportQuery | undefined;
  if (endpoint === "patchBrand") {
    const p = BrandPatchRequest.safeParse(raw);
    if (!p.success) return err({ error: "invalid", request_id: rid, issues: issues(p.error) });
    patch = p.data;
  } else if (endpoint === "pauseBrand" || endpoint === "resumeBrand") {
    const p = BrandStatusChangeRequest.safeParse(rawObj);
    if (!p.success) return err({ error: "invalid", request_id: rid, issues: issues(p.error) });
    reason = p.data.reason;
  } else if (endpoint === "leadAggregates") {
    const q = LeadAggregatesQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
  } else if (endpoint === "listAudit") {
    const q = AuditQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
    auditQuery = q.data;
  } else if (endpoint === "funnelReport") {
    const q = FunnelQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
  } else if (endpoint === "alertsReport") {
    const q = AlertsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
  } else if (endpoint === "spendReport") {
    const q = SpendQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
  } else if (endpoint === "conversionsReport") {
    const q = ConversionsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
    conversionsQuery = q.data;
  } else if (endpoint === "trafficRisk" || endpoint === "trafficRiskExport") {
    const q = (endpoint === "trafficRisk" ? TrafficRiskQuery : TrafficRiskExportQuery).safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
  } else if (endpoint === "listLeads") {
    // spec leads
    const q = LeadsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
    leadsQuery = q.data;
  } else if (endpoint === "leadExport") {
    const q = LeadExportQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
    leadExportQuery = q.data;
  } else if (endpoint === "listSuppressions") {
    const q = SuppressionsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
  }

  if (endpoint === "trafficBreakdown") {
    const q = TrafficBreakdownQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
    return json(200, { ...q.data, ...trafficWindow(q.data.period), timezone: "America/New_York",
      rows: q.data.by === "hour" ? Array.from({ length: 24 }, (_, hour) => ({ key: String(hour).padStart(2, "0"), visits: 0, leads: 0 })) : [], brands: [] });
  }

  // 4. field groups
  if (endpoint === "patchBrand" && patch) {
    const fields = authorize(endpoint, ctx.actor_role, patch);
    if (!fields.ok) return err({ ...fields.error, request_id: rid });
  }
  // spec leads: a boolean, because the parsed `pii` is the string "0" | "1" and "0" is truthy.
  if (endpoint === "leadExport" && leadExportQuery) {
    const pii = authorize(endpoint, ctx.actor_role, { pii: leadExportQuery.pii === "1" });
    if (!pii.ok) return err({ ...pii.error, request_id: rid });
  }
  if (endpoint === "listAudit" && ctx.actor_role !== "owner" && auditQuery?.actor_id && auditQuery.actor_id !== ctx.actor_id) {
    return err({ error: "forbidden_role", required_role: "owner", request_id: rid });
  }

  // 5. existence
  const brand = params.id ? state.brands.get(params.id) : undefined;
  if (params.id && !brand) return err({ error: "not_found", resource: "brand", request_id: rid });

  switch (endpoint) {
    case "listBrands": {
      const stats = new Map(brandsList.brands.map((b) => [b.brand_id, b.stats_7d]));
      return json(200, {
        brands: [...state.brands.values()].map((b) => ({
          brand_id: b.brand_id,
          hostnames: b.hostnames,
          status: b.status,
          flow_gate_mode: b.flow_gate_mode,
          ab_config: b.ab_config,
          form_version: b.form_version,
          stats_7d: stats.get(b.brand_id) ?? { leads: 0, sold: 0, pending: 0 },
        })),
        generated_at: new Date().toISOString(),
      });
    }
    case "getBrand":
      return json(200, { brand: brand });
    case "patchBrand": {
      const b = brand!;
      // 6. optimistic concurrency
      if (patch!.expected_updated_at && patch!.expected_updated_at !== b.updated_at) {
        return err({ error: "conflict", request_id: rid, current_updated_at: b.updated_at });
      }
      const next: BrandConfig = structuredClone(b);
      const changed: BrandPatchField[] = [];
      const old: Record<string, unknown> = {};
      const now: Record<string, unknown> = {};
      for (const f of BRAND_PATCH_FIELDS) {
        const v = patch![f];
        if (v === undefined) continue;
        if (f === "rotate_postback_token") {
          old.postback_token = b.postback_token;
          now.postback_token = "set";
          next.postback_token = "set";
          changed.push(f);
          continue;
        }
        if (JSON.stringify(b[f]) === JSON.stringify(v)) continue;
        old[f] = b[f];
        now[f] = v;
        (next as Record<string, unknown>)[f] = v;
        changed.push(f);
      }
      let audit_id: number | null = null;
      if (changed.length > 0) {
        next.updated_at = new Date().toISOString();
        state.brands.set(b.brand_id, BrandConfig.parse(next));
        audit_id = audit(ctx.actor_id, ctx.actor_role, "brand.update", b.brand_id, old as AuditEntry["old"], now as AuditEntry["new"]);
      }
      return json(200, {
        brand: state.brands.get(b.brand_id),
        changed,
        audit_id,
        ...(changed.includes("rotate_postback_token") ? { issued_postback_token: randomToken() } : {}),
      });
    }
    case "pauseBrand":
    case "resumeBrand": {
      const b = brand!;
      const target = endpoint === "pauseBrand" ? "paused" : "live";
      if (b.status === target) return json(200, { brand_id: b.brand_id, status: b.status, changed: false, audit_id: null });
      state.brands.set(b.brand_id, { ...b, status: target, updated_at: new Date().toISOString() });
      const audit_id = audit(
        ctx.actor_id,
        ctx.actor_role,
        endpoint === "pauseBrand" ? "brand.pause" : "brand.resume",
        b.brand_id,
        { status: b.status },
        reason ? { status: target, reason } : { status: target },
      );
      return json(200, { brand_id: b.brand_id, status: target, changed: true, audit_id });
    }
    case "leadAggregates":
      return json(200, aggregates);
    case "getLead":
      if (params.lead_id !== lead.lead.lead_id) return err({ error: "not_found", resource: "lead", request_id: rid });
      // The two fixtures differ exactly in the PII and money fields, so no redaction happens here.
      return json(200, ctx.actor_role !== "owner" ? leadEmployee : lead);
    // spec leads
    // The mock filters by brand and status only. It ignores the day window, `q`, `limit` and the
    // cursor, so `next_cursor` is always null; that is not a bug. It writes no audit row either:
    // real core owns the PII audit and the mock has no factory D1 to write it to.
    case "listLeads": {
      const rows = leadsList.rows.filter(
        (r) => (!leadsQuery?.brand || r.brand === leadsQuery.brand) && (!leadsQuery?.status || r.outcome === leadsQuery.status),
      );
      return json(200, { rows, next_cursor: null });
    }
    case "leadExport": {
      const source = leadExportQuery?.pii === "1" ? leadsExportPii : leadsExport;
      const rows = source.rows.filter(
        (r) => (!leadExportQuery?.brand || r.brand === leadExportQuery.brand) && (!leadExportQuery?.status || r.outcome === leadExportQuery.status),
      );
      return json(200, { ...source, rows });
    }
    case "listSuppressions":
      return json(200, { ...suppressionsList, next_cursor: null });
    case "listAudit": {
      const own = gate.ok && gate.scope === "own";
      const limit = auditQuery?.limit ?? 50;
      const entries = [...state.audit]
        .sort((x, y) => y.id - x.id)
        .filter((e) => (own ? e.actor_id === ctx.actor_id : !auditQuery?.actor_id || e.actor_id === auditQuery.actor_id))
        .filter((e) => !auditQuery?.target_type || e.target.type === auditQuery.target_type)
        .filter((e) => !auditQuery?.target_id || e.target.id === auditQuery.target_id)
        .slice(0, limit);
      return json(200, { entries, next_cursor: null });
    }
    case "funnelReport":
      return json(200, ctx.actor_role === "owner" ? funnelReport : { ...funnelReport, rows: funnelReport.rows.map((r) => ({ ...r, revenue: null })) });
    case "alertsReport":
      return json(200, alertsReport);
    case "mailingStatus":
      return json(200, mailingStatus);
    case "spendReport":
      return json(200, { ...spendReport, period: url.searchParams.get("period") });
    case "conversionsReport": {
      const q = conversionsQuery!;
      const owner = ctx.actor_role === "owner";
      // Same order as core: dead, pending, processing, uploaded; then the latest update first; then lead_id.
      const rank: Record<string, number> = { dead: 0, pending: 1, processing: 2, uploaded: 3 };
      const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      const rows = conversionsReport.rows
        .filter((r) => q.status === "all" || r.status === q.status)
        .filter((r) => !q.brand || r.brand === q.brand)
        .map((r) => ({
          ...r,
          value: owner ? r.value : null,
          last_error: owner ? r.last_error : employeeLastError(r.last_error),
        }))
        .sort((a, b) => rank[a.status]! - rank[b.status]! || byText(b.updated_at ?? b.created_at, a.updated_at ?? a.created_at) || byText(a.lead_id, b.lead_id));
      return json(200, { ...conversionsReport, period: q.period, value_totals: owner ? conversionsReport.value_totals : null, rows });
    }
    case "trafficRisk":
      return json(200, trafficRisk);
    case "trafficRiskExport": {
      const hostname = url.searchParams.get("hostname");
      return json(200, { ...trafficRiskExport, rows: trafficRiskExport.rows.filter((row) => !hostname || row.hostname === hostname) });
    }
    // spec traffic: golden fixtures with the query period echoed; the employee view nulls error_message.
    case "trafficReport": {
      const q = TrafficReportQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
      const window = trafficLogWindow(q.data.period);
      const first = trafficReport.trend[0]!;
      const zero = { landing_views: 0, form_starts: 0, leads: 0, validation_errors: 0, redirect_errors: 0 };
      const trend = trafficLogBuckets(window).map((at, i) => (i === 0 ? { ...first, at } : { ...zero, at }));
      return json(200, { ...trafficReport, period: q.data.period, ...window, trend });
    }
    case "clientErrors": {
      const q = ClientErrorsQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!q.success) return err({ error: "invalid", request_id: rid, issues: issues(q.error) });
      const owner = ctx.actor_role === "owner";
      const inBrand = clientErrors.rows.filter((r) => !q.data.brand_id || r.brand_id === q.data.brand_id);
      const tally = new Map<string, number>();
      for (const r of inBrand) tally.set(r.error_type, (tally.get(r.error_type) ?? 0) + 1);
      const counts = [...tally]
        .map(([error_type, count]) => ({ error_type, count }))
        .sort((a, b) => b.count - a.count || (a.error_type < b.error_type ? -1 : a.error_type > b.error_type ? 1 : 0));
      const rows = inBrand
        .filter((r) => !q.data.error_type || r.error_type === q.data.error_type)
        .filter((r) => !q.data.cursor || r.id < Number(q.data.cursor))
        .map((r) => ({ ...r, error_message: owner ? r.error_message : null }));
      const { from, to } = trafficLogWindow(q.data.period);
      return json(200, { ...clientErrors, period: q.data.period, from, to, counts, rows });
    }
    default: {
      const unexpected: never = endpoint;
      return err({ error: "not_found", resource: "route", request_id: `${rid}:${String(unexpected)}` });
    }
  }
  // Unreachable while AdminApi and the switch agree.
  return err({ error: "not_found", resource: "route", request_id: rid });
}

/** Keeps `AdminApi` referenced so a new endpoint without a mock case is a typecheck-visible TODO. */
export const MOCK_ENDPOINTS = Object.keys(AdminApi);
