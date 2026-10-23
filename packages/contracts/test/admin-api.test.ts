import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_CONTEXT_HEADERS,
  ADMIN_ENDPOINTS,
  ADMIN_ERROR_STATUS,
  ADMIN_ROLE_TABLE,
  AdminApi,
  AdminError,
  AdminRequestContext,
  AlertsQuery,
  AlertsReportResponse,
  adminContextFromHeaders,
  adminContextToHeaders,
  AuditListResponse,
  authorize,
  BRAND_PATCH_FIELD_GROUPS,
  BRAND_PATCH_FIELDS,
  BrandConfig,
  BrandPatchRequest,
  BrandPatchResponse,
  BrandStatusChangeRequest,
  BrandStatusChangeResponse,
  DeployHistoryResponse,
  FunnelQuery,
  FunnelReportResponse,
  GetBrandResponse,
  GetLeadResponse,
  LeadAggregatesQuery,
  LeadAggregatesResponse,
  LEAD_EXPORT_COLUMNS,
  LEAD_EXPORT_PII_COLUMNS,
  LeadExportResponse,
  LeadExportRow,
  leadOutcome,
  LeadsQuery,
  LeadsResponse,
  ListBrandsResponse,
  MailingStatusResponse,
  matchAdminRoute,
  SpendReportResponse,
  SuppressionsResponse,
  RISK_SIGNALS,
  TrafficRiskExportQuery,
  TrafficRiskExportResponse,
  TrafficRiskQuery,
  TrafficRiskResponse,
  type AdminEndpoint,
  type AdminRole,
} from "../src/index.js";
import { fixture, fixtureText, PKG_DIR } from "./helpers.js";

const A = (f: string) => `admin/${f}`;

describe("golden fixtures validate", () => {
  const cases: [string, { safeParse(v: unknown): { success: boolean } }][] = [
    ["context.owner.json", AdminRequestContext],
    ["context.employee.json", AdminRequestContext],
    ["brands.list.response.json", ListBrandsResponse],
    ["brand.get.response.json", GetBrandResponse],
    ["brand.get.response.no-token.json", GetBrandResponse],
    ["brand.patch.request.employee.json", BrandPatchRequest],
    ["brand.patch.request.owner.json", BrandPatchRequest],
    ["brand.patch.request.rotate.json", BrandPatchRequest],
    ["brand.patch.response.json", BrandPatchResponse],
    ["brand.patch.response.rotate.json", BrandPatchResponse],
    ["brand.pause.request.json", BrandStatusChangeRequest],
    ["brand.pause.response.json", BrandStatusChangeResponse],
    ["brand.resume.response.noop.json", BrandStatusChangeResponse],
    ["leads.aggregates.query.json", LeadAggregatesQuery],
    ["leads.aggregates.response.json", LeadAggregatesResponse],
    ["lead.get.response.json", GetLeadResponse],
    ["lead.get.response.employee.json", GetLeadResponse],
    ["leads.list.response.json", LeadsResponse],
    ["leads.export.response.json", LeadExportResponse],
    ["leads.export.response.pii.json", LeadExportResponse],
    ["suppressions.list.response.json", SuppressionsResponse],
    ["audit.list.response.owner.json", AuditListResponse],
    ["audit.list.response.employee.json", AuditListResponse],
    ["funnel.query.json", FunnelQuery],
    ["funnel.response.json", FunnelReportResponse],
    ["alerts.response.json", AlertsReportResponse],
    ["mailing.response.json", MailingStatusResponse],
    ["spend.response.json", SpendReportResponse],
    ["traffic-risk.response.json", TrafficRiskResponse],
    ["traffic-risk.export.response.json", TrafficRiskExportResponse],
    ["error.unauthorized.json", AdminError],
    ["error.forbidden-role.endpoint.json", AdminError],
    ["error.forbidden-role.fields.json", AdminError],
    ["error.not-found.json", AdminError],
    ["error.conflict.json", AdminError],
    ["error.invalid.json", AdminError],
    ["deploys.response.json", DeployHistoryResponse],
  ];

  it.each(cases)("%s", (f, schema) => {
    const r = schema.safeParse(fixture(A(f)));
    expect(r.success).toBe(true);
  });

  it("every file in fixtures/admin is covered above", () => {
    const files = readdirSync(join(PKG_DIR, "fixtures", "admin")).sort();
    expect(files).toEqual(cases.map(([f]) => f).sort());
  });

  it("each endpoint's response schema accepts its golden fixture", () => {
    expect(AdminApi.listBrands.response.safeParse(fixture(A("brands.list.response.json"))).success).toBe(true);
    expect(AdminApi.getBrand.response.safeParse(fixture(A("brand.get.response.json"))).success).toBe(true);
    expect(AdminApi.patchBrand.response.safeParse(fixture(A("brand.patch.response.json"))).success).toBe(true);
    expect(AdminApi.pauseBrand.response.safeParse(fixture(A("brand.pause.response.json"))).success).toBe(true);
    expect(AdminApi.resumeBrand.response.safeParse(fixture(A("brand.resume.response.noop.json"))).success).toBe(true);
    expect(AdminApi.leadAggregates.response.safeParse(fixture(A("leads.aggregates.response.json"))).success).toBe(true);
    expect(AdminApi.getLead.response.safeParse(fixture(A("lead.get.response.json"))).success).toBe(true);
    expect(AdminApi.listAudit.response.safeParse(fixture(A("audit.list.response.owner.json"))).success).toBe(true);
    expect(AdminApi.funnelReport.response.safeParse(fixture(A("funnel.response.json"))).success).toBe(true);
    expect(AdminApi.alertsReport.response.safeParse(fixture(A("alerts.response.json"))).success).toBe(true);
    expect(AdminApi.mailingStatus.response.safeParse(fixture(A("mailing.response.json"))).success).toBe(true);
    expect(AdminApi.spendReport.response.safeParse(fixture(A("spend.response.json"))).success).toBe(true);
    expect(AdminApi.trafficRisk.response.safeParse(fixture(A("traffic-risk.response.json"))).success).toBe(true);
    expect(AdminApi.trafficRiskExport.response.safeParse(fixture(A("traffic-risk.export.response.json"))).success).toBe(true);
  });

  it("every error code maps to the agreed HTTP status", () => {
    expect(ADMIN_ERROR_STATUS).toEqual({ unauthorized: 401, forbidden_role: 403, not_found: 404, conflict: 409, invalid: 422 });
  });
});

describe("request context", () => {
  it("round-trips through the Service Binding headers", () => {
    const ctx = AdminRequestContext.parse(fixture(A("context.employee.json")));
    const h = new Headers(adminContextToHeaders(ctx));
    expect(adminContextFromHeaders(h)).toEqual(ctx);
  });

  it("missing or unknown role -> null (401)", () => {
    const h = new Headers(adminContextToHeaders(AdminRequestContext.parse(fixture(A("context.owner.json")))));
    h.set(ADMIN_CONTEXT_HEADERS.actor_role, "admin");
    expect(adminContextFromHeaders(h)).toBeNull();
    h.delete(ADMIN_CONTEXT_HEADERS.actor_role);
    expect(adminContextFromHeaders(h)).toBeNull();
    expect(adminContextFromHeaders(new Headers())).toBeNull();
  });
});

describe("authorize()", () => {
  it("employee may edit site text; values are validated", () => {
    expect(authorize("patchBrand", "employee", { brand_name: "Quick Funds", site_title: null }).ok).toBe(true);
    expect(BrandPatchRequest.safeParse({ site_description: "Personal Loan offers" }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ site_title: "T".repeat(71) }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ brand_name: null }).success).toBe(true);
  });

  it("drain route fields are owner-only, validated, and clearable with null", () => {
    const route = { google_ads_account: "1234567890", google_conversion_action: "7754587837", adkit_project: "proj_A-1" };
    expect(BrandPatchRequest.safeParse(route).success).toBe(true);
    expect(BrandPatchRequest.safeParse({ google_ads_account: null, google_conversion_action: null, adkit_project: null }).success).toBe(true);
    for (const bad of [
      { google_ads_account: "123-456-7890" }, { google_ads_account: "123456789" }, { google_ads_account: "12345678901" },
      { google_conversion_action: "" }, { google_conversion_action: "1".repeat(21) }, { google_conversion_action: "12a" },
      { adkit_project: "" }, { adkit_project: "a b" }, { adkit_project: "p".repeat(65) },
    ]) expect(BrandPatchRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(authorize("patchBrand", "owner", route).ok).toBe(true);
    const r = authorize("patchBrand", "employee", route);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.denied_fields).toEqual(["google_ads_account", "google_conversion_action", "adkit_project"]);
  });

  it("owner-only PATCH fields are rejected for an employee, each one listed", () => {
    const employeeFields: string[] = ["keyword_default", "brand_name", "site_title", "site_description"];
    const ownerOnly = BRAND_PATCH_FIELDS.filter((f) => !employeeFields.includes(f));
    for (const f of ownerOnly) {
      const r = authorize("patchBrand", "employee", { [f]: f === "rotate_postback_token" ? true : "x" });
      expect(r.ok, f).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(403);
        expect(r.error.denied_fields).toEqual([f]);
        expect(AdminError.safeParse(r.error).success).toBe(true);
      }
    }
  });

  it("the owner golden patch is denied to an employee and allowed to the owner", () => {
    const patch = fixture<Record<string, unknown>>(A("brand.patch.request.owner.json"));
    const r = authorize("patchBrand", "employee", patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.denied_fields?.sort()).toEqual(["ab_config", "amount_buckets", "flow_gate_mode"]);
    expect(authorize("patchBrand", "owner", patch)).toEqual({ ok: true, scope: "all" });
  });

  it("a mixed patch is rejected whole (no partial apply)", () => {
    const r = authorize("patchBrand", "employee", { keyword_default: "Quick Cash", aid: "10002" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.denied_fields).toEqual(["aid"]);
  });

  it("employee may edit keyword_default (incl. clearing it) and send expected_updated_at", () => {
    expect(authorize("patchBrand", "employee", fixture(A("brand.patch.request.employee.json"))).ok).toBe(true);
    expect(authorize("patchBrand", "employee", { keyword_default: null }).ok).toBe(true);
  });

  it("unknown patch keys fail closed for an employee", () => {
    const r = authorize("patchBrand", "employee", { postback_token_hash: "x" });
    expect(r.ok).toBe(false);
  });

  it("lead detail and aggregates are open to employees; the PII fields are redacted by core", () => {
    expect(authorize("getLead", "employee").ok).toBe(true);
    expect(authorize("getLead", "owner").ok).toBe(true);
    expect(authorize("leadAggregates", "employee").ok).toBe(true);
  });

  it("audit: employee scope is own, owner scope is all", () => {
    expect(authorize("listAudit", "employee")).toEqual({ ok: true, scope: "own" });
    expect(authorize("listAudit", "owner")).toEqual({ ok: true, scope: "all" });
    const emp = AdminRequestContext.parse(fixture(A("context.employee.json")));
    const page = AuditListResponse.parse(fixture(A("audit.list.response.employee.json")));
    for (const e of page.entries) expect(e.actor_id).toBe(emp.actor_id);
  });

  it("pause and resume are allowed to employees (stop the bleeding)", () => {
    expect(authorize("pauseBrand", "employee").ok).toBe(true);
    expect(authorize("resumeBrand", "employee").ok).toBe(true);
  });
});

describe("secrets never appear in GET fixtures", () => {
  const getFixtures = [
    "brands.list.response.json",
    "brand.get.response.json",
    "brand.get.response.no-token.json",
    "leads.aggregates.response.json",
    "lead.get.response.json",
    "audit.list.response.owner.json",
    "audit.list.response.employee.json",
    "funnel.response.json",
    "alerts.response.json",
    "mailing.response.json",
    "spend.response.json",
  ];
  const SECRET_KEY = /(hash|secret|password|api_?key|credential|dsn)/i;
  const rotated = fixture<{ issued_postback_token: string }>(A("brand.patch.response.rotate.json")).issued_postback_token;

  function walk(v: unknown, path: string, out: { path: string; key: string; value: unknown }[]) {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, out));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        out.push({ path: `${path}.${k}`, key: k, value: x });
        walk(x, `${path}.${k}`, out);
      }
  }

  it.each(getFixtures)("%s carries no secret key or value", (f) => {
    const nodes: { path: string; key: string; value: unknown }[] = [];
    walk(fixture(A(f)), "$", nodes);
    for (const n of nodes) {
      expect(SECRET_KEY.test(n.key), n.path).toBe(false);
      if (/token/i.test(n.key) && n.key !== "postback_token_rotated") {
        expect(["set", "not_set"], n.path).toContain(n.value);
      }
      if (typeof n.value === "string") {
        expect(n.value, n.path).not.toMatch(/^[0-9a-f]{64}$/i); // a SHA-256 hash
        expect(n.value, n.path).not.toBe(rotated);
      }
    }
    expect(fixtureText(A(f))).not.toContain(rotated);
  });

  it("BrandConfig rejects the token hash column and a token value", () => {
    const brand = fixture<{ brand: Record<string, unknown> }>(A("brand.get.response.json")).brand;
    expect(BrandConfig.safeParse({ ...brand, postback_token_hash: "a".repeat(64) }).success).toBe(false);
    expect(BrandConfig.safeParse({ ...brand, postback_token: "a".repeat(64) }).success).toBe(false);
    expect(BrandConfig.safeParse({ ...brand, postback_token: rotated }).success).toBe(false);
  });

  it("aggregates carry counts only, never a lead id or applicant field", () => {
    const row = LeadAggregatesResponse.parse(fixture(A("leads.aggregates.response.json"))).rows[0]!;
    expect(Object.keys(row).sort()).toEqual(["brand_id", "count", "day", "status"]);
    expect(LeadAggregatesResponse.safeParse({ ...fixture<object>(A("leads.aggregates.response.json")), rows: [{ ...row, email: "x@example.com" }] }).success).toBe(false);
    expect(LeadAggregatesResponse.safeParse({ ...fixture<object>(A("leads.aggregates.response.json")), rows: [{ ...row, lead_id: "6f1c2b9e" }] }).success).toBe(false);
  });

  it("the list summary has no account routing or token fields", () => {
    const b = ListBrandsResponse.parse(fixture(A("brands.list.response.json"))).brands[0]!;
    for (const k of ["aid", "prepop_base", "drain_key", "postback_token", "postback_token_hash"]) expect(Object.keys(b)).not.toContain(k);
  });
});

/**
 * The T12 plan's role matrix (docs/plans/t12-control-panel.md, "Roles"), rows that this API
 * implements. Rows owned by other tasks (add brand/install, rollback, upgrade-all, data-subject
 * deletion, manage users) are listed separately and must NOT appear in the table.
 */
const PLAN_MATRIX: { action: string; employee: "yes" | "no" | "own"; covered_by: (AdminEndpoint | `patch:${string}`)[] }[] = [
  { action: "View brands, funnel, alerts, mailing status", employee: "yes", covered_by: ["listBrands", "getBrand", "leadAggregates", "funnelReport", "trafficBreakdown", "alertsReport", "mailingStatus", "trafficRisk"] },
  { action: "Export high-risk clicks for a refund request (FUS-372)", employee: "no", covered_by: ["trafficRiskExport"] },
  { action: "Edit keyword default", employee: "yes", covered_by: ["patch:keyword"] },
  { action: "Edit site text", employee: "yes", covered_by: ["patch:site_text"] },
  { action: "Pause / resume a brand", employee: "yes", covered_by: ["pauseBrand", "resumeBrand"] },
  { action: "Change A/B weights", employee: "no", covered_by: ["patch:ab_weights"] },
  { action: "Change amount buckets", employee: "no", covered_by: ["patch:amount_buckets"] },
  { action: "Switch flow gate mode (`param` / `signed_cookie`)", employee: "no", covered_by: ["patch:flow_gate_mode"] },
  { action: "Set LeadsGate aid, postback token, drain key, prepop base", employee: "no", covered_by: ["patch:money_routing"] },
  // The PII *fields* of getLead are owner-only inside the handler (core redacts by role), so the
  // endpoint table cannot show them. workers/core/test/admin.test.ts covers that field-level rule.
  { action: "View individual leads without PII", employee: "yes", covered_by: ["listLeads", "getLead", "leadExport"] },
  { action: "Search the email suppression list", employee: "no", covered_by: ["listSuppressions"] },
  { action: "View audit log", employee: "own", covered_by: ["listAudit"] },
  { action: "View ad spend, cost per lead and profit (FUS-368)", employee: "no", covered_by: ["spendReport"] },
];
const PLAN_ROWS_OUT_OF_SCOPE = [
  "Add a brand (domain + keyword) and run install", // T10
  "Roll back a brand to its previous version", // T10
  "Upgrade all brands (canary first)", // T10
  "Data-subject deletion", // follow-up
  "Manage users", // T12a (auth D1)
];

describe("role table matches the plan matrix", () => {
  const row = (key: string) => {
    const r = key.startsWith("patch:")
      ? ADMIN_ROLE_TABLE.find((x) => x.field_group === key.slice(6))
      : ADMIN_ROLE_TABLE.find((x) => x.endpoint === key && x.field_group === null);
    if (!r) throw new Error(`no role table row for ${key}`);
    return r;
  };

  it.each(PLAN_MATRIX)("$action", ({ employee, covered_by }) => {
    for (const key of covered_by) {
      const r = row(key);
      expect(r.min_role, key).toBe(employee === "no" ? "owner" : "employee");
      expect(r.scope.owner, key).toBe("all");
      expect(r.scope.employee, key).toBe(employee === "no" ? "none" : employee === "own" ? "own" : "all");
    }
  });

  it("every endpoint and every field group is covered by a plan row", () => {
    const covered = new Set(PLAN_MATRIX.flatMap((p) => p.covered_by));
    covered.add("patchBrand"); // endpoint floor; its groups carry the real rule
    for (const r of ADMIN_ROLE_TABLE) {
      const key = r.field_group ? `patch:${r.field_group}` : r.endpoint;
      expect(covered.has(key as AdminEndpoint), r.key).toBe(true);
    }
  });

  it("field groups name their plan row verbatim", () => {
    const actions = new Set(PLAN_MATRIX.map((p) => p.action));
    for (const g of Object.values(BRAND_PATCH_FIELD_GROUPS)) expect(actions.has(g.plan_action), g.plan_action).toBe(true);
  });

  it("each PATCH field sits in exactly one group, and the groups cover the request schema", () => {
    const all = Object.values(BRAND_PATCH_FIELD_GROUPS).flatMap((g) => [...g.fields]);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...BRAND_PATCH_FIELDS].sort());
    const shapeKeys = Object.keys(BrandPatchRequest.shape).filter((k) => k !== "expected_updated_at");
    expect(shapeKeys.sort()).toEqual([...BRAND_PATCH_FIELDS].sort());
  });

  it("rollback / install / upgrade are not part of this API (factory, T10)", () => {
    expect(PLAN_ROWS_OUT_OF_SCOPE).toHaveLength(5);
    for (const r of ADMIN_ROLE_TABLE) expect(r.key).not.toMatch(/rollback|install|upgrade/);
  });

  it("table keys are unique and use the routing table's method + path", () => {
    const keys = ADMIN_ROLE_TABLE.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("GET /admin/brands");
    expect(keys).toContain("PATCH /admin/brands/:id#money_routing");
    expect(keys).toContain("GET /admin/leads/:lead_id");
  });

  it("authorize() agrees with the table for both roles", () => {
    for (const r of ADMIN_ROLE_TABLE) {
      for (const role of ["employee", "owner"] as AdminRole[]) {
        const patch = r.fields ? Object.fromEntries(r.fields.map((f) => [f, "x"])) : undefined;
        const res = authorize(r.endpoint, role, patch);
        expect(res.ok, `${r.key} as ${role}`).toBe(r.scope[role] !== "none");
      }
    }
  });
});

describe("routing", () => {
  it("matches every endpoint and extracts params", () => {
    expect(matchAdminRoute("GET", "/admin/brands")).toEqual({ endpoint: "listBrands", params: {} });
    expect(matchAdminRoute("GET", "/admin/brands/brand-a")).toEqual({ endpoint: "getBrand", params: { id: "brand-a" } });
    expect(matchAdminRoute("PATCH", "/admin/brands/brand-a")).toEqual({ endpoint: "patchBrand", params: { id: "brand-a" } });
    expect(matchAdminRoute("POST", "/admin/brands/brand-a/pause")?.endpoint).toBe("pauseBrand");
    expect(matchAdminRoute("POST", "/admin/brands/brand-a/resume")?.endpoint).toBe("resumeBrand");
    expect(matchAdminRoute("GET", "/admin/leads/aggregates")).toEqual({ endpoint: "leadAggregates", params: {} });
    expect(matchAdminRoute("GET", "/admin/leads/6f1c2b9e-3a4d")).toEqual({ endpoint: "getLead", params: { lead_id: "6f1c2b9e-3a4d" } });
    expect(matchAdminRoute("GET", "/admin/audit")?.endpoint).toBe("listAudit");
    expect(matchAdminRoute("GET", "/admin/funnel")).toEqual({ endpoint: "funnelReport", params: {} });
    expect(matchAdminRoute("GET", "/admin/alerts")).toEqual({ endpoint: "alertsReport", params: {} });
    expect(matchAdminRoute("GET", "/admin/mailing")).toEqual({ endpoint: "mailingStatus", params: {} });
    expect(matchAdminRoute("GET", "/admin/spend")).toEqual({ endpoint: "spendReport", params: {} });
    expect(matchAdminRoute("GET", "/admin/traffic/risk")).toEqual({ endpoint: "trafficRisk", params: {} });
    expect(matchAdminRoute("GET", "/admin/traffic/risk/export")).toEqual({ endpoint: "trafficRiskExport", params: {} });
    expect(matchAdminRoute("DELETE", "/admin/brands/brand-a")).toBeNull();
    expect(matchAdminRoute("POST", "/admin/brands/brand-a/rollback")).toBeNull();
    expect(matchAdminRoute("GET", "/admin/traffic/breakdown")).toEqual({ endpoint: "trafficBreakdown", params: {} });
    expect(matchAdminRoute("GET", "/admin/leads")).toEqual({ endpoint: "listLeads", params: {} });
    expect(matchAdminRoute("GET", "/admin/leads/export")).toEqual({ endpoint: "leadExport", params: {} });
    expect(matchAdminRoute("GET", "/admin/suppressions")).toEqual({ endpoint: "listSuppressions", params: {} });
    expect(ADMIN_ENDPOINTS).toHaveLength(18);
  });
});

describe("schema rules", () => {
  it("validates report queries and rejects inverted or empty funnel windows", () => {
    const query = FunnelQuery.parse(fixture(A("funnel.query.json")));
    expect(AdminApi.funnelReport.query.safeParse(query).success).toBe(true);
    expect(FunnelQuery.safeParse({ ...query, from: query.to, to: query.from }).success).toBe(false);
    expect(FunnelQuery.safeParse({ ...query, to: query.from }).success).toBe(false);
    expect(AlertsQuery.safeParse({}).success).toBe(true);
    expect(AlertsQuery.safeParse({ now: query.to }).success).toBe(true);
    expect(AlertsQuery.safeParse({ now: "invalid" }).success).toBe(false);
  });

  it("risk queries default to 7d and accept only today, 7d and 30d", () => {
    expect(TrafficRiskQuery.parse({})).toEqual({ period: "7d" });
    expect(TrafficRiskQuery.safeParse({ period: "30d" }).success).toBe(true);
    expect(TrafficRiskQuery.safeParse({ period: "90d" }).success).toBe(false);
    expect(TrafficRiskQuery.safeParse({ period: "7d", hostname: "a.example" }).success).toBe(false);
    expect(TrafficRiskExportQuery.parse({ hostname: "brand-a.example" })).toEqual({ period: "7d", hostname: "brand-a.example" });
    expect(TrafficRiskExportQuery.safeParse({ hostname: "Brand A" }).success).toBe(false);
  });

  it("risk signals carry the V1 weights", () => {
    expect(RISK_SIGNALS.map((s) => [s.id, s.weight])).toEqual([
      ["known_bot_ua", 50], ["timezone_geo_mismatch", 20], ["rapid_repeat_session", 30],
    ]);
    const report = fixture<Record<string, any>>(A("traffic-risk.response.json"));
    expect(TrafficRiskResponse.safeParse({ ...report, hours: report.hours.slice(1) }).success).toBe(false);
    expect(TrafficRiskResponse.safeParse({ ...report, signals: [{ ...report.signals[0], id: "made_up" }] }).success).toBe(false);
  });

  it("A/B weights must sum to 100 with unique ids", () => {
    const p = fixture<Record<string, any>>(A("brand.patch.request.owner.json"));
    expect(BrandPatchRequest.safeParse({ ab_config: { ...p.ab_config, variants: [{ id: "a", weight: 70 }, { id: "b", weight: 20 }] } }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ ab_config: { ...p.ab_config, variants: [{ id: "a", weight: 50 }, { id: "a", weight: 50 }] } }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ ab_config: null }).success).toBe(true);
  });

  it("amount buckets are unique, ascending and within the V1 range", () => {
    expect(BrandPatchRequest.safeParse({ amount_buckets: [1000, 500] }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ amount_buckets: [500, 500] }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ amount_buckets: [50] }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ amount_buckets: [] }).success).toBe(false);
  });

  it("keyword_default must be clean (BR-4); empty patch and unknown keys are invalid", () => {
    expect(BrandPatchRequest.safeParse({ keyword_default: "<b>cash</b>" }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({}).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ expected_updated_at: "2026-10-01T09:30:00.000Z" }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ status: "paused" }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ rotate_postback_token: false }).success).toBe(false);
  });

  it.each(["/apply", "/apply/", "/buyer/apply"])("accepts same-origin prepop_base %s", (prepop_base) => {
    expect(BrandPatchRequest.safeParse({ prepop_base }).success).toBe(true);
  });

  it.each(["//external.example/apply", "/\\external.example/apply", "/apply?aid=999", "/apply#fragment", "apply"])("rejects unsafe prepop_base %s", (prepop_base) => {
    expect(BrandPatchRequest.safeParse({ prepop_base }).success).toBe(false);
  });

  it("prepop_base is https without query", () => {
    expect(BrandPatchRequest.safeParse({ prepop_base: "http://prepop.example/apply" }).success).toBe(false);
    expect(BrandPatchRequest.safeParse({ prepop_base: "https://prepop.example/apply?aid=1" }).success).toBe(false);
  });

  it("aggregates window is ordered and at most 93 days", () => {
    expect(LeadAggregatesQuery.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
    expect(LeadAggregatesQuery.safeParse({ from: "2026-07-01", to: "2026-10-01" }).success).toBe(true);
    expect(LeadAggregatesQuery.safeParse({ from: "2026-06-01", to: "2026-10-01" }).success).toBe(false);
  });

  it("pause/resume audit_id is set exactly when the status changed", () => {
    expect(BrandStatusChangeResponse.safeParse({ brand_id: "brand-a", status: "paused", changed: true, audit_id: null }).success).toBe(false);
    expect(BrandStatusChangeResponse.safeParse({ brand_id: "brand-a", status: "paused", changed: false, audit_id: 7 }).success).toBe(false);
  });

  it("leadOutcome maps V1/postback statuses", () => {
    expect(leadOutcome("accepted")).toBe("pending");
    expect(leadOutcome("newLead")).toBe("pending");
    expect(leadOutcome("soldLead")).toBe("sold");
    expect(leadOutcome("rejectLead")).toBe("rejected");
    const lead = GetLeadResponse.parse(fixture(A("lead.get.response.json"))).lead;
    expect(lead.outcome).toBe(leadOutcome(lead.status));
  });

  it("list stats: sold + pending cannot exceed leads", () => {
    const list = fixture<{ brands: Record<string, unknown>[]; generated_at: string }>(A("brands.list.response.json"));
    const bad = { ...list, brands: [{ ...list.brands[0], stats_7d: { leads: 1, sold: 1, pending: 1 } }] };
    expect(ListBrandsResponse.safeParse(bad).success).toBe(false);
  });
});

// spec leads
describe("leads, export and suppressions (FUS-376)", () => {
  it("leads query refuses a window longer than 93 days and from after to", () => {
    expect(LeadsQuery.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
    expect(LeadsQuery.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success).toBe(false);
    expect(LeadsQuery.safeParse({ from: "2026-07-01", to: "2026-10-01" }).success).toBe(true);
    expect(LeadsQuery.safeParse({}).success).toBe(true); // both absent is allowed
    expect(LeadsQuery.safeParse({ q: "ab" }).success).toBe(false); // under 4 chars
    expect(LeadsQuery.safeParse({ q: "ab%_" }).success).toBe(false);
    expect(LeadsQuery.safeParse({ limit: 201 }).success).toBe(false);
    expect(LeadsQuery.safeParse({ status: "sold", brand: "brand-a" }).success).toBe(true);
    expect(LeadsQuery.safeParse({ email: "a@example.com" }).success).toBe(false); // no email search
  });

  it("export query refuses a bad window and defaults to the non-PII column set", () => {
    expect(AdminApi.leadExport.query.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
    expect(AdminApi.leadExport.query.safeParse({ pii: "yes" }).success).toBe(false);
    expect(AdminApi.leadExport.query.parse({})).toEqual({ pii: "0", limit: 5000 });
    expect(AdminApi.leadExport.query.safeParse({ limit: 5001 }).success).toBe(false);
  });

  it("lead export refuses pii=1 for an employee and allows it for an owner", () => {
    const denied = authorize("leadExport", "employee", { pii: true });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error).toEqual({ error: "forbidden_role", required_role: "owner", denied_fields: ["pii"] });
      expect(AdminError.safeParse(denied.error).success).toBe(true);
    }
    expect(authorize("leadExport", "employee").ok).toBe(true);
    expect(authorize("leadExport", "employee", { pii: false }).ok).toBe(true);
    expect(authorize("leadExport", "owner", { pii: true }).ok).toBe(true);
  });

  it("lead detail parses the employee fixture with applicant, payout and value null", () => {
    const employeeLead = AdminApi.getLead.response.parse(fixture(A("lead.get.response.employee.json"))).lead;
    expect(employeeLead.applicant).toBeNull();
    expect(employeeLead.postbacks.every((p) => p.payout === null)).toBe(true);
    expect(employeeLead.conversion?.value).toBeNull();
    expect(employeeLead.conversion?.last_error).toBeNull();
    expect(employeeLead.profile.state).toBe("TX");
    expect(JSON.stringify(employeeLead)).not.toContain("fixture-click");
  });

  it("the owner and employee lead fixtures differ only in the PII and money fields", () => {
    const owner = GetLeadResponse.parse(fixture(A("lead.get.response.json"))).lead;
    const employee = GetLeadResponse.parse(fixture(A("lead.get.response.employee.json"))).lead;
    expect(owner.applicant).not.toBeNull();
    expect({
      ...employee,
      applicant: owner.applicant,
      postbacks: owner.postbacks,
      conversion: owner.conversion && { ...employee.conversion, value: owner.conversion.value, last_error: owner.conversion.last_error },
    }).toEqual(owner);
    expect(owner.postbacks.some((p) => p.payout !== null)).toBe(true);
    expect(owner.conversion?.value).not.toBeNull();
  });

  it("every new endpoint parses its fixture and sits in the role table", () => {
    const row = (e: AdminEndpoint) => ADMIN_ROLE_TABLE.find((r) => r.endpoint === e)!;
    expect(AdminApi.listLeads.response.safeParse(fixture(A("leads.list.response.json"))).success).toBe(true);
    expect(AdminApi.leadExport.response.safeParse(fixture(A("leads.export.response.json"))).success).toBe(true);
    expect(AdminApi.leadExport.response.safeParse(fixture(A("leads.export.response.pii.json"))).success).toBe(true);
    expect(AdminApi.listSuppressions.response.safeParse(fixture(A("suppressions.list.response.json"))).success).toBe(true);
    expect(row("listLeads").min_role).toBe("employee");
    expect(row("leadExport").min_role).toBe("employee");
    expect(row("listSuppressions").min_role).toBe("owner");
    expect(row("getLead").min_role).toBe("employee");
    expect(row("getLead").scope).toEqual({ employee: "all", owner: "all" });
    expect(row("listSuppressions").scope).toEqual({ employee: "none", owner: "all" });
  });

  it("authorize() refuses the suppression search to an employee", () => {
    const r = authorize("listSuppressions", "employee");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ error: "forbidden_role", required_role: "owner" });
  });

  it("export column constants cover every row field and keep PII last", () => {
    const plain = fixture<{ rows: Record<string, unknown>[] }>(A("leads.export.response.json")).rows[0]!;
    const pii = fixture<{ rows: Record<string, unknown>[] }>(A("leads.export.response.pii.json")).rows[0]!;
    expect(Object.keys(LeadExportRow.parse(plain)).sort()).toEqual([...LEAD_EXPORT_COLUMNS].sort());
    expect(Object.keys(LeadExportRow.parse(pii)).sort()).toEqual([...LEAD_EXPORT_PII_COLUMNS].sort());
    expect(LEAD_EXPORT_PII_COLUMNS.slice(0, LEAD_EXPORT_COLUMNS.length)).toEqual([...LEAD_EXPORT_COLUMNS]);
    expect(new Set(LEAD_EXPORT_PII_COLUMNS).size).toBe(LEAD_EXPORT_PII_COLUMNS.length);
    expect(LEAD_EXPORT_PII_COLUMNS).toContain("email");
    expect(LEAD_EXPORT_COLUMNS).not.toContain("email");
    expect(LEAD_EXPORT_COLUMNS).toEqual(expect.arrayContaining(["has_conversion", "postback_count"]));
    expect(LEAD_EXPORT_PII_COLUMNS).not.toContain("click_id");
  });

  it("no PII column is in the non-PII export set", () => {
    for (const c of ["first_name", "last_name", "birth_date", "email", "home_phone", "work_phone", "address", "city", "zip"]) {
      expect(LEAD_EXPORT_COLUMNS, c).not.toContain(c);
      expect(LEAD_EXPORT_PII_COLUMNS, c).toContain(c);
    }
    expect(LeadExportRow.safeParse({ ...fixture<{ rows: object[] }>(A("leads.export.response.json")).rows[0], click_id: "x" }).success).toBe(false);
  });

  it("no new fixture carries a click id value or key", () => {
    for (const f of ["lead.get.response.json", "lead.get.response.employee.json", "leads.list.response.json", "leads.export.response.json", "leads.export.response.pii.json"]) {
      expect(fixtureText(A(f)), f).not.toMatch(/"(gclid|gbraid|wbraid|msclkid|click_id)"\s*:|fixture-click/);
    }
  });

  it("suppressions query accepts the known reasons and sources only", () => {
    expect(AdminApi.listSuppressions.query.safeParse({ q: "a@", reason: "bounce", source: "ses" }).success).toBe(true);
    expect(AdminApi.listSuppressions.query.safeParse({ reason: "spam" }).success).toBe(false);
    expect(AdminApi.listSuppressions.query.safeParse({ source: "other" }).success).toBe(false);
    expect(AdminApi.listSuppressions.query.safeParse({ q: "" }).success).toBe(false);
    expect(AdminApi.listSuppressions.query.safeParse({ limit: 201 }).success).toBe(false);
  });

  it("the audit action list names the four PII actions", () => {
    for (const a of ["pii.lead_view", "pii.lead_export", "lead.export", "pii.suppression_search"]) {
      expect(ADMIN_AUDIT_ACTIONS).toContain(a);
    }
  });
});
