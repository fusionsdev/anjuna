import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
  FunnelQuery,
  FunnelReportResponse,
  GetBrandResponse,
  GetLeadResponse,
  LeadAggregatesQuery,
  LeadAggregatesResponse,
  leadOutcome,
  ListBrandsResponse,
  MailingStatusResponse,
  matchAdminRoute,
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
    ["audit.list.response.owner.json", AuditListResponse],
    ["audit.list.response.employee.json", AuditListResponse],
    ["funnel.query.json", FunnelQuery],
    ["funnel.response.json", FunnelReportResponse],
    ["alerts.response.json", AlertsReportResponse],
    ["mailing.response.json", MailingStatusResponse],
    ["error.unauthorized.json", AdminError],
    ["error.forbidden-role.endpoint.json", AdminError],
    ["error.forbidden-role.fields.json", AdminError],
    ["error.not-found.json", AdminError],
    ["error.conflict.json", AdminError],
    ["error.invalid.json", AdminError],
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
  it("owner-only PATCH fields are rejected for an employee, each one listed", () => {
    const ownerOnly = BRAND_PATCH_FIELDS.filter((f) => f !== "keyword_default");
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

  it("lead detail is owner-only; aggregates are open to employees", () => {
    const r = authorize("getLead", "employee");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ error: "forbidden_role", required_role: "owner" });
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
  { action: "View brands, funnel, alerts, mailing status", employee: "yes", covered_by: ["listBrands", "getBrand", "leadAggregates", "funnelReport", "alertsReport", "mailingStatus"] },
  { action: "Edit keyword default", employee: "yes", covered_by: ["patch:keyword"] },
  { action: "Pause / resume a brand", employee: "yes", covered_by: ["pauseBrand", "resumeBrand"] },
  { action: "Change A/B weights", employee: "no", covered_by: ["patch:ab_weights"] },
  { action: "Change amount buckets", employee: "no", covered_by: ["patch:amount_buckets"] },
  { action: "Switch flow gate mode (`param` / `signed_cookie`)", employee: "no", covered_by: ["patch:flow_gate_mode"] },
  { action: "Set LeadsGate aid, postback token, drain key, prepop base", employee: "no", covered_by: ["patch:money_routing"] },
  { action: "View individual leads with PII", employee: "no", covered_by: ["getLead"] },
  { action: "View audit log", employee: "own", covered_by: ["listAudit"] },
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
    expect(matchAdminRoute("DELETE", "/admin/brands/brand-a")).toBeNull();
    expect(matchAdminRoute("POST", "/admin/brands/brand-a/rollback")).toBeNull();
    expect(ADMIN_ENDPOINTS).toHaveLength(11);
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
