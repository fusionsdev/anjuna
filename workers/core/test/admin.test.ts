import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AlertsReportResponse,
  AuditEntry,
  AuditListResponse,
  BrandPatchResponse,
  BrandStatusChangeResponse,
  FunnelReportResponse,
  GetBrandResponse,
  GetLeadResponse,
  LEAD_EXPORT_COLUMNS,
  LEAD_EXPORT_PII_COLUMNS,
  LeadAggregatesResponse,
  LeadExportResponse,
  LeadsResponse,
  ListBrandsResponse,
  MailingStatusResponse,
  SuppressionsResponse,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { decodeLeadCursor, encodeLeadCursor, likeEscape, resolveLeadWindow } from "../src/admin/index.js";
import { createHarness, fixtureText, type Harness } from "./helpers.js";

const owner: AdminRequestContext = {
  actor_id: "usr_owner_01",
  actor_role: "owner",
  request_id: "req_01HZX9K2M4N6P8Q0",
};
const employee: AdminRequestContext = {
  actor_id: "usr_emp_01",
  actor_role: "employee",
  request_id: "req_01HZX9K2M4N6P8Q1",
};
const leadId = "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.seedBrand("brand-a", "original-token", "main");
  await h.db.prepare(
    `UPDATE brand_runtime SET
       hostnames = ?1, drain_key = 'brand_a', aid = '10001',
       amount_buckets = '[500,1000,1500,2500]',
       ab_config_json = ?2, keyword_default = 'Fast Cash Loans',
       created_at = '2026-09-30T08:00:00.000Z',
       updated_at = '2026-10-01T09:30:00.000Z'
     WHERE brand_id = 'brand-a'`,
  ).bind(
    JSON.stringify(["brand-a.example", "www.brand-a.example"]),
    JSON.stringify({
      experiment_id: "exp-2026-10",
      variants: [{ id: "A", weight: 50 }, { id: "B", weight: 50 }],
    }),
  ).run();
  await h.seedBrand("brand-b", "other-token", "main");
  await h.db.prepare(
    `UPDATE brand_runtime SET paused = 1, amount_buckets = '[500]',
       created_at = '2026-09-30T08:00:00.000Z',
       updated_at = '2026-10-01T09:30:00.000Z'
     WHERE brand_id = 'brand-b'`,
  ).run();
  await h.seedLead(leadId, "6f1c2b9e3a4d4c5e8f607a8b9c0d1e2f", "brand-a");
  await h.db.prepare(
    `UPDATE leads SET status = 'soldLead', form_version = '2026-01',
       form_variant = 'lite_v1', experiment_id = 'exp-2026-10', variant = 'A',
       keyword = 'Fast Cash Loans', requested_amount = 1000,
       loan_purpose = 'DEBT_CONSOLIDATION', birth_date = '1990-01-15',
       work_phone = NULL, own_home = 0, employer = 'Example Co',
       employed_months = 36, monthly_income = 3200,
       created_at = '2026-10-01T12:00:00.000Z',
       updated_at = '2026-10-01T12:01:10.000Z'
     WHERE lead_id = ?1`,
  ).bind(leadId).run();
  await h.db.prepare(
    `INSERT INTO postback_events (lead_id, event_type, payout, created_at)
     VALUES (?1, 'soldLead', 85, '2026-10-01T12:00:30.000Z')`,
  ).bind(leadId).run();
});
afterAll(async () => { await h?.mf.dispose(); });

function fixture<T>(path: string): T {
  return JSON.parse(fixtureText(`admin/${path}`)) as T;
}

function body(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

async function auditCount(): Promise<number> {
  const row = await h.factory.prepare("SELECT count(*) AS count FROM audit_log").first<{ count: number }>();
  return Number(row!.count);
}

describe("AdminService contract", () => {
  it("returns the seeded D1 funnel to employees with no synthetic telemetry", async () => {
    const filter = fixture<Record<string, string>>("funnel.query.json");
    const query = new URLSearchParams({ ...filter, keyword: "Fast Cash Loans", variant: "A" });
    const response = await h.admin(`/admin/funnel?${query}`, employee);
    expect(response.status).toBe(200);
    expect(FunnelReportResponse.parse(await response.json())).toEqual({
      from: filter.from,
      to: filter.to,
      rows: [{
        brand: "brand-a", keyword: "Fast Cash Loans", variant: "A",
        clicks: 0, go_count: 0, form_views: 0, submits: 1, sold: 1, revenue: null,
        submit_rate: null, sold_rate: 1,
      }],
    });

    query.set("from", filter.to!);
    query.set("to", filter.from!);
    const invalid = await h.admin(`/admin/funnel?${query}`, employee);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: "invalid", request_id: employee.request_id });
  });

  it("sends funnel revenue to the owner and null revenue to an employee", async () => {
    const query = new URLSearchParams({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" });
    const asOwner = FunnelReportResponse.parse(await (await h.admin(`/admin/funnel?${query}`, owner)).json());
    const asEmployee = FunnelReportResponse.parse(await (await h.admin(`/admin/funnel?${query}`, employee)).json());
    expect(asOwner.rows.length).toBeGreaterThan(0);
    expect(asOwner.rows.every((r) => typeof r.revenue === "number")).toBe(true);
    expect(asEmployee.rows.map((r) => r.revenue)).toEqual(asOwner.rows.map(() => null));
    expect(asEmployee.rows.map((r) => r.sold)).toEqual(asOwner.rows.map((r) => r.sold));
    // Only revenue is withheld: an employee still gets the numbers for clicks, submits and sold.
    for (const field of ["clicks", "submits", "sold"] as const) {
      expect(asEmployee.rows.map((r) => r[field]), field).toEqual(asOwner.rows.map((r) => r[field]));
      expect(asEmployee.rows.every((r) => typeof r[field] === "number"), field).toBe(true);
    }
  });

  it("returns D1 alerts to employees at a deterministic time", async () => {
    const response = await h.admin("/admin/alerts?now=2026-10-02T00:00:00.000Z", employee);
    expect(response.status).toBe(200);
    const report = AlertsReportResponse.parse(await response.json());
    expect(report).toMatchObject({
      generated_at: "2026-10-02T00:00:00.000Z",
      conversion_stalled: { state: "ok", detail: { stuck_count: 0, oldest_created_at: null } },
      brands_without_postbacks: { state: "ok", detail: { brands: [] } },
      submit_error_rate: { state: "ok", detail: { samples: [] } },
      reject_rate: { state: "ok" },
    });
  });

  it("returns local mailing counts without listmonk configuration or outbound fetch", async () => {
    await h.db.prepare(
      `INSERT INTO mailing_outbox (lead_id, brand, created_at)
       VALUES (?1, 'brand-a', '2026-10-01T12:00:00.000Z')`,
    ).bind(leadId).run();
    const before = await h.db.prepare("SELECT * FROM mailing_outbox").all();
    const auditBefore = await auditCount();
    const response = await h.admin("/admin/mailing", employee);
    expect(response.status).toBe(200);
    expect(MailingStatusResponse.parse(await response.json())).toEqual({
      external_sync: "not_configured",
      counts: { pending: 1, sent: 0, skipped: 0, dead: 0 },
    });
    expect((await h.db.prepare("SELECT * FROM mailing_outbox").all()).results).toEqual(before.results);
    expect(await auditCount()).toBe(auditBefore);
  });

  it.each(["LISTMONK_URL", "LISTMONK_USER", "LISTMONK_TOKEN"] as const)(
    "keeps mailing local and not_configured when only %s is unset",
    async (missing) => {
      const listmonk: Partial<Record<typeof missing, string>> = {
        LISTMONK_URL: "https://listmonk.invalid",
        LISTMONK_USER: "test-user",
        LISTMONK_TOKEN: "test-token",
      };
      delete listmonk[missing];
      const local = await createHarness({ listmonk });
      try {
        await local.seedBrand();
        await local.seedLead(leadId);
        await local.db.prepare(
          `INSERT INTO mailing_outbox (lead_id, brand, created_at)
           VALUES (?1, 'brand-a', '2026-10-01T12:00:00.000Z')`,
        ).bind(leadId).run();
        const response = await local.admin("/admin/mailing", employee);
        expect(response.status).toBe(200);
        expect(MailingStatusResponse.parse(await response.json())).toEqual({
          external_sync: "not_configured",
          counts: { pending: 1, sent: 0, skipped: 0, dead: 0 },
        });
      } finally {
        await local.mf.dispose();
      }
    },
  );

  it("round-trips every read endpoint through its contract schema", async () => {
    const list = await h.admin("/admin/brands", employee);
    expect(list.status).toBe(200);
    const listed = ListBrandsResponse.parse(await list.json());
    expect(listed.brands).toHaveLength(2);
    expect(listed.brands[0]!.ab_config!.variants.map((variant) => variant.id)).toEqual(["a", "b"]);
    expect(listed.brands[0]!.form_version).toBeNull();
    expect(listed.brands[0]!.stats_7d).toEqual({ leads: 0, sold: 0, pending: 0 });

    // stats_7d counts from the real clock; move the fixture lead into the window, then restore it.
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    await h.db.prepare("UPDATE leads SET created_at = ?1 WHERE lead_id = ?2").bind(recent, leadId).run();
    const recentList = ListBrandsResponse.parse(await (await h.admin("/admin/brands", employee)).json());
    expect(recentList.brands[0]!.stats_7d).toEqual({ leads: 1, sold: 1, pending: 0 });
    await h.db.prepare("UPDATE leads SET created_at = '2026-10-01T12:00:00.000Z' WHERE lead_id = ?1").bind(leadId).run();

    const brand = await h.admin("/admin/brands/brand-a", employee);
    expect(GetBrandResponse.parse(await brand.json()).brand).toMatchObject({
      brand_id: "brand-a",
      postback_token: "set",
      form_version: null,
      ab_config: { variants: [{ id: "a", weight: 50 }, { id: "b", weight: 50 }] },
    });

    const query = new URLSearchParams(fixture<Record<string, string>>("leads.aggregates.query.json"));
    const aggregates = await h.admin(`/admin/leads/aggregates?${query}`, employee);
    expect(LeadAggregatesResponse.parse(await aggregates.json()).rows).toEqual([
      { brand_id: "brand-a", day: "2026-10-01", status: "sold", count: 1 },
    ]);

    const lead = await h.admin(`/admin/leads/${leadId}`, owner);
    const detail = GetLeadResponse.parse(await lead.json()).lead;
    expect(detail).toMatchObject({ lead_id: leadId, outcome: "sold", variant: "a" });
    expect(detail.applicant!.email).toBe("test@example.com");
    expect(detail.profile.state).toBe("TX");
    expect(detail.conversion).toBeNull();

    // The owner read above released PII, so it is the only audit row so far.
    const audit = await h.admin("/admin/audit", owner);
    expect(AuditListResponse.parse(await audit.json()).entries).toMatchObject([
      { action: "pii.lead_view", actor_id: owner.actor_id, target: { type: "lead", id: leadId } },
    ]);
  });

  it("returns contract errors for missing context, invalid input, conflicts and missing rows", async () => {
    const panel = await h.mf.getWorker("panel");
    const unauthorized = await panel.fetch("https://core.internal/admin/brands", {
      headers: { "x-production": "1" },
    });
    expect([unauthorized.status, await unauthorized.json()]).toEqual([401, fixture("error.unauthorized.json")]);

    const invalid = await h.admin("/admin/brands/brand-a", owner, {
      method: "PATCH",
      body: JSON.stringify({ amount_buckets: [1000, 500] }),
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: "invalid", request_id: owner.request_id });

    const conflict = await h.admin("/admin/brands/brand-a", employee, {
      method: "PATCH",
      body: JSON.stringify({ keyword_default: "Quick Cash Today", expected_updated_at: "2026-01-01T00:00:00.000Z" }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "conflict",
      current_updated_at: "2026-10-01T09:30:00.000Z",
      request_id: employee.request_id,
    });

    const missing = await h.admin("/admin/brands/missing", employee);
    expect([missing.status, await missing.json()]).toEqual([
      404,
      { error: "not_found", resource: "brand", request_id: employee.request_id },
    ]);
  });

  it("denies every owner-only field and endpoint to an employee before database access", async () => {
    const ownerOnly: Array<[string, unknown]> = [
      ["amount_buckets", [500, 1000]],
      ["ab_config", { experiment_id: "exp-next", variants: [{ id: "a", weight: 50 }, { id: "b", weight: 50 }] }],
      ["flow_gate_mode", "signed_cookie"],
      ["aid", "10002"],
      ["prepop_base", "https://prepop.example/new"],
      ["drain_key", "brand_new"],
      ["google_ads_account", "1234567890"],
      ["google_conversion_action", "7754587837"],
      ["adkit_project", "proj-a"],
      ["rotate_postback_token", true],
      ["unknown_field", "closed"],
    ];
    const before = await auditCount();
    for (const [field, value] of ownerOnly) {
      const response = await h.admin("/admin/brands/missing", employee, {
        method: "PATCH",
        body: JSON.stringify({ [field]: value }),
      });
      expect(response.status, field).toBe(403);
      expect(await response.json(), field).toMatchObject({
        error: "forbidden_role",
        required_role: "owner",
        denied_fields: [field],
        request_id: employee.request_id,
      });
    }
    const endpoint = await h.admin("/admin/traffic/risk/export?period=7d", employee);
    expect(endpoint.status, "trafficRiskExport").toBe(403);
    expect(await endpoint.json(), "trafficRiskExport").toMatchObject({
      error: "forbidden_role",
      required_role: "owner",
      request_id: employee.request_id,
    });
    expect(await auditCount()).toBe(before);
  });

  it("lets an employee edit keyword, pause and resume, with exactly one audit row per mutation", async () => {
    const before = await auditCount();
    const patch = await h.admin("/admin/brands/brand-a", employee, {
      method: "PATCH",
      body: fixtureText("admin/brand.patch.request.employee.json"),
    });
    expect(patch.status).toBe(200);
    expect(BrandPatchResponse.parse(await patch.json())).toMatchObject({
      changed: ["keyword_default"],
      brand: { keyword_default: "Quick Cash Today" },
    });

    const pause = await h.admin("/admin/brands/brand-a/pause", employee, body(fixture("brand.pause.request.json")));
    expect(BrandStatusChangeResponse.parse(await pause.json())).toMatchObject({ status: "paused", changed: true });
    const resume = await h.admin("/admin/brands/brand-a/resume", employee, body({ reason: "Recovered" }));
    expect(BrandStatusChangeResponse.parse(await resume.json())).toMatchObject({ status: "live", changed: true });
    expect(await auditCount()).toBe(before + 3);

    const rows = await h.factory.prepare(
      "SELECT action, before_json, after_json FROM audit_log ORDER BY id DESC LIMIT 3",
    ).all<{ action: string; before_json: string; after_json: string }>();
    expect(rows.results.map((row) => row.action)).toEqual(["brand.resume", "brand.pause", "brand.update"]);
    expect(JSON.parse(rows.results[2]!.before_json)).toEqual({ keyword_default: "Fast Cash Loans" });
    expect(JSON.parse(rows.results[2]!.after_json)).toEqual({ keyword_default: "Quick Cash Today" });
    expect(JSON.parse(rows.results[1]!.before_json)).toEqual({ status: "live" });
    expect(JSON.parse(rows.results[1]!.after_json)).toEqual({
      status: "paused",
      reason: "Reject rate spike on brand-a",
    });

    const noOpBefore = await auditCount();
    const noOp = await h.admin("/admin/brands/brand-a/resume", employee, body({}));
    expect(await noOp.json()).toEqual({ brand_id: "brand-a", status: "live", changed: false, audit_id: null });
    expect(await auditCount()).toBe(noOpBefore);
  });

  it("applies the owner patch fixture and returns only the newly rotated token", async () => {
    const current = GetBrandResponse.parse(await (await h.admin("/admin/brands/brand-a", owner)).json()).brand;
    const ownerPatch = fixture<Record<string, unknown>>("brand.patch.request.owner.json");
    ownerPatch.expected_updated_at = current.updated_at;
    const updated = await h.admin("/admin/brands/brand-a", owner, {
      method: "PATCH",
      body: JSON.stringify(ownerPatch),
    });
    expect(BrandPatchResponse.parse(await updated.json())).toMatchObject({
      changed: ["amount_buckets", "ab_config", "flow_gate_mode"],
    });

    const before = await auditCount();
    const rotated = await h.admin("/admin/brands/brand-a", owner, {
      method: "PATCH",
      body: fixtureText("admin/brand.patch.request.rotate.json"),
    });
    const result = BrandPatchResponse.parse(await rotated.json());
    expect(result.changed).toEqual(["rotate_postback_token"]);
    expect(result.issued_postback_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await auditCount()).toBe(before + 1);
    const stored = await h.db.prepare(
      "SELECT postback_token_hash FROM brand_runtime WHERE brand_id = 'brand-a'",
    ).first<{ postback_token_hash: string }>();
    expect(stored!.postback_token_hash).toBe(
      createHash("sha256").update(result.issued_postback_token!).digest("hex"),
    );

    const getText = await (await h.admin("/admin/brands/brand-a", owner)).text();
    expect(GetBrandResponse.parse(JSON.parse(getText)).brand.postback_token).toBe("set");
    expect(getText).not.toContain(result.issued_postback_token!);
    expect(getText).not.toContain(stored!.postback_token_hash);
    const listText = await (await h.admin("/admin/brands", owner)).text();
    expect(listText).not.toContain(result.issued_postback_token!);
    expect(listText).not.toContain(stored!.postback_token_hash);
  });

  it("keeps PII owner-only and scopes audit visibility by role", async () => {
    const redacted = await h.admin(`/admin/leads/${leadId}`, employee);
    expect(redacted.status).toBe(200);
    expect(GetLeadResponse.parse(await redacted.json()).lead.applicant).toBeNull();
    const allowed = GetLeadResponse.parse(await (await h.admin(`/admin/leads/${leadId}`, owner)).json());
    expect(allowed.lead.applicant!.first_name).toBe("Test");

    const employeePage = AuditListResponse.parse(await (await h.admin("/admin/audit", employee)).json());
    expect(employeePage.entries.length).toBeGreaterThan(0);
    expect(employeePage.entries.every((entry) => entry.actor_id === employee.actor_id)).toBe(true);
    const forbidden = await h.admin("/admin/audit?actor_id=usr_owner_01", employee);
    expect(forbidden.status).toBe(403);

    const ownerPage = AuditListResponse.parse(await (await h.admin("/admin/audit?limit=2", owner)).json());
    expect(ownerPage.entries).toHaveLength(2);
    expect(new Set(ownerPage.entries.map((entry) => entry.actor_id))).toContain(owner.actor_id);
    expect(ownerPage.next_cursor).not.toBeNull();
    const next = AuditListResponse.parse(
      await (await h.admin(`/admin/audit?limit=2&cursor=${ownerPage.next_cursor}`, owner)).json(),
    );
    expect(next.entries[0]!.id).toBeLessThan(ownerPage.entries[1]!.id);
  });

  it("keeps public /admin routes unavailable", async () => {
    for (const path of ["/admin/brands", `/admin/leads/${leadId}`, "/admin/audit", "/admin/funnel", "/admin/alerts", "/admin/mailing"]) {
      const response = await h.request(path);
      expect([response.status, await response.text()]).toEqual([404, "Not Found"]);
    }
  });
});

describe("mailing status with LISTMONK_* set", () => {
  let configured: Harness;
  beforeAll(async () => {
    configured = await createHarness({
      listmonk: {
        LISTMONK_URL: "https://listmonk.example",
        LISTMONK_USER: "api",
        LISTMONK_TOKEN: "fixture-token",
        LISTMONK_LIST_MAP: '{"brand-a":7}',
      },
    });
  });
  afterAll(async () => { await configured?.mf.dispose(); });

  it("reports configured and never calls listmonk", async () => {
    const mailing = await configured.admin("/admin/mailing", employee);
    expect(mailing.status).toBe(200);
    expect(MailingStatusResponse.parse(await mailing.json()).external_sync).toBe("configured");
  });

  it("reports configured without a list map: each brand has its own list and the map is only a fallback", async () => {
    const local = await createHarness({
      listmonk: {
        LISTMONK_URL: "https://listmonk.example",
        LISTMONK_USER: "api",
        LISTMONK_TOKEN: "fixture-token",
      },
    });
    try {
      const mailing = await local.admin("/admin/mailing", employee);
      expect(mailing.status).toBe(200);
      expect(MailingStatusResponse.parse(await mailing.json()).external_sync).toBe("configured");
    } finally {
      await local.mf.dispose();
    }
  });
});

describe("site text through the admin API", () => {
  const save = (body: unknown) => h.admin("/admin/brands/brand-a", employee, { method: "PATCH", body: JSON.stringify(body) });

  it("lets an employee edit site text, validates it, and resets a field with null", async () => {
    const ok = await save({ brand_name: "Quick Funds", site_title: "Quick Funds | Check Your Options", site_description: "Compare funding options from lending partners." });
    expect(ok.status).toBe(200);
    expect(BrandPatchResponse.parse(await ok.json())).toMatchObject({ changed: ["brand_name", "site_title", "site_description"], brand: { brand_name: "Quick Funds" } });
    for (const bad of [{ site_title: "T".repeat(71) }, { site_description: "Personal Loans for everyone" }, { brand_name: "Anjuna Funds" }, { site_title: "<b>Bold</b>" }]) {
      expect((await save(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    const reset = await save({ site_title: null });
    expect(BrandPatchResponse.parse(await reset.json()).brand.site_title).toBeNull();
    const brand = GetBrandResponse.parse(await (await h.admin("/admin/brands/brand-a", employee)).json()).brand;
    expect(brand).toMatchObject({ brand_name: "Quick Funds", site_title: null, site_description: "Compare funding options from lending partners." });
  });
});

describe("postback token state with a tenant-wide token", () => {
  let g: Harness;
  beforeAll(async () => {
    g = await createHarness({ bindings: { POSTBACK_TOKEN: "g".repeat(40) } });
    await g.seedBrand("brand-a", "own", "main");
    await g.seedBrand("brand-c", "unused", "main");
    await g.db.prepare("UPDATE brand_runtime SET amount_buckets = '[500,1000]'").run();
    await g.db.prepare("UPDATE brand_runtime SET postback_token_hash = NULL WHERE brand_id = 'brand-c'").run();
  });
  afterAll(async () => { await g?.mf.dispose(); });

  it("reports global for a brand without its own token and set for one with it", async () => {
    const own = GetBrandResponse.parse(await (await g.admin("/admin/brands/brand-a", owner)).json());
    const covered = GetBrandResponse.parse(await (await g.admin("/admin/brands/brand-c", owner)).json());
    expect([own.brand.postback_token, covered.brand.postback_token]).toEqual(["set", "global"]);
    expect(JSON.stringify(covered)).not.toContain("g".repeat(40));
  });
});

describe("drain route through the admin API", () => {
  const save = (context: AdminRequestContext, patch: unknown) =>
    h.admin("/admin/brands/brand-b", context, { method: "PATCH", body: JSON.stringify(patch) });
  const route = { google_ads_account: "4811219623", google_conversion_action: "7754587837", adkit_project: "proj_b-1" };

  it("lets the owner set, audit and clear the route; validates every field", async () => {
    const before = await auditCount();
    const ok = await save(owner, route);
    expect(ok.status).toBe(200);
    expect(BrandPatchResponse.parse(await ok.json())).toMatchObject({
      changed: ["google_ads_account", "google_conversion_action", "adkit_project"], brand: route,
    });
    expect(await auditCount()).toBe(before + 1);
    const audit = await h.factory.prepare("SELECT action, before_json, after_json FROM audit_log ORDER BY id DESC LIMIT 1")
      .first<{ action: string; before_json: string; after_json: string }>();
    expect(audit!.action).toBe("brand.update");
    expect(JSON.parse(audit!.before_json)).toEqual({ google_ads_account: null, google_conversion_action: null, adkit_project: null });
    expect(JSON.parse(audit!.after_json)).toEqual(route);

    for (const bad of [{ google_ads_account: "481-121-9623" }, { google_ads_account: "481121962" },
      { google_conversion_action: "77x" }, { adkit_project: "a/b" }]) {
      expect((await save(owner, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    const cleared = await save(owner, { adkit_project: null });
    expect(BrandPatchResponse.parse(await cleared.json()).brand).toMatchObject({ ...route, adkit_project: null });
    const brand = GetBrandResponse.parse(await (await h.admin("/admin/brands/brand-b", employee)).json()).brand;
    expect(brand).toMatchObject({ ...route, adkit_project: null });
  });

  it("refuses an employee patch of the route and leaves the row unchanged", async () => {
    const stored = () => h.db.prepare(
      "SELECT google_ads_account, google_conversion_action, adkit_project, updated_at FROM brand_runtime WHERE brand_id = 'brand-b'",
    ).first();
    const before = await stored();
    const auditBefore = await auditCount();
    const denied = await save(employee, { google_ads_account: "1111111111" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "forbidden_role", denied_fields: ["google_ads_account"] });
    expect(await stored()).toEqual(before);
    expect(await auditCount()).toBe(auditBefore);
  });
});

// spec leads
describe("GET /admin/leads (FUS-376)", () => {
  // seedLead writes a fixed created_at for every lead; each lead below is moved with an UPDATE.
  const WINDOW = "from=2026-09-01&to=2026-10-31";
  const DAY_MS = 86_400_000;
  let lh: Harness;

  const leadsAt = async (path: string, context: AdminRequestContext = owner) => {
    const response = await lh.admin(path, context);
    expect(response.status, path).toBe(200);
    return LeadsResponse.parse(await response.json());
  };
  const ids = (page: LeadsResponse) => page.rows.map((row) => row.lead_id);

  // Binds created_at directly, so a test can batch many inserts in one D1 round trip instead of looping.
  const insert = (id: string, brand: string, createdAt: string) => lh.db.prepare(`INSERT INTO leads (
      lead_id, session_id, form_version, form_variant, site_id, brand, hostname,
      requested_amount, loan_purpose, first_name, last_name, birth_date, email, home_phone,
      address, city, state, zip, address_length_months, own_home, income_type, employer,
      job_title, employed_months, pay_date1, pay_frequency, direct_deposit, monthly_income,
      tracking_json, metadata_json, created_at, click_id
    ) VALUES (?1, 'session', 'test', 'lite_v1', 'form-default', ?2, ?3,
      1000, 'OTHER', 'Test', 'Applicant', '1990-01-01', 'test@example.com', '2145550123',
      '100 Example St', 'Dallas', 'TX', '75201', 24, 0, 'EMPLOYMENT', 'Example',
      'Clerk', 24, '2026-10-09', 'BIWEEKLY', 1, 3000, '{}', '{}', ?4, ?5)`)
    .bind(id, brand, `${brand}.example`, createdAt, `clk-${id}`);

  beforeAll(async () => {
    lh = await createHarness();
    for (const brand of ["brand-a", "brand-b", "brand-c"]) await lh.seedBrand(brand);
    const seed = async (id: string, brand: string, createdAt: string, status: string, click: string) => {
      await lh.seedLead(id, click, brand);
      await lh.db.prepare("UPDATE leads SET created_at = ?1, status = ?2 WHERE lead_id = ?3")
        .bind(createdAt, status, id).run();
    };
    await seed("lead-0001-newest", "brand-a", "2026-10-05T00:00:00.000Z", "soldLead", "clk-sold-0001");
    await seed("lead-0002-reject", "brand-a", "2026-10-04T23:59:59.999Z", "rejectLead", "clk-rej-0002");
    await seed("lead-0003-pending", "brand-a", "2026-10-04T08:00:00.000Z", "newLead", "clk-pend-0003");
    for (const n of [1, 2, 3]) {
      await seed(`tie-000000000${n}`, "brand-b", "2026-10-03T10:00:00.000Z", "newLead", `clk-tie-000${n}`);
    }
    await seed("lead-0009-older", "brand-b", "2026-09-10T00:00:00.000Z", "newLead", "clk-old-0009");
    // Only the newest lead has keyword/variant; every other row keeps them NULL like a V1-era lead.
    await lh.db.prepare("UPDATE leads SET keyword = 'Fast Cash', variant = 'A', experiment_id = 'exp-2026-10' WHERE lead_id = 'lead-0001-newest'").run();
    await lh.seedConversion("lead-0001-newest");
    await lh.db.batch([
      lh.db.prepare("INSERT INTO postback_events (lead_id, event_type, payout, created_at) VALUES ('lead-0001-newest', 'newLead', 0, '2026-10-05T00:00:10.000Z')"),
      lh.db.prepare("INSERT INTO postback_events (lead_id, event_type, payout, created_at) VALUES ('lead-0001-newest', 'soldLead', 85, '2026-10-05T00:00:30.000Z')"),
    ]);
  });
  afterAll(async () => { await lh?.mf.dispose(); });

  it("pages newest first and the cursor returns the next page with no overlap", async () => {
    const expected = [
      "lead-0001-newest", "lead-0002-reject", "lead-0003-pending",
      "tie-0000000003", "tie-0000000002", "tie-0000000001", "lead-0009-older",
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const page: LeadsResponse = await leadsAt(`/admin/leads?${WINDOW}&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      sizes.push(page.rows.length);
      seen.push(...ids(page));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(sizes).toEqual([2, 2, 2, 1]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("pages leads that share a created_at to the millisecond without skipping or repeating one", async () => {
    const tie = "brand=brand-b&from=2026-10-01&to=2026-10-03";
    const first = await leadsAt(`/admin/leads?${tie}&limit=2`);
    expect(ids(first)).toEqual(["tie-0000000003", "tie-0000000002"]);
    expect(first.next_cursor).not.toBeNull();
    const second = await leadsAt(`/admin/leads?${tie}&limit=2&cursor=${first.next_cursor}`);
    expect(ids(second)).toEqual(["tie-0000000001"]);
    expect(second.next_cursor).toBeNull();

    const single: string[] = [];
    let cursor: string | null = null;
    do {
      const page: LeadsResponse = await leadsAt(`/admin/leads?${tie}&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      single.push(...ids(page));
      cursor = page.next_cursor;
    } while (cursor);
    expect(single).toEqual(["tie-0000000003", "tie-0000000002", "tie-0000000001"]);
  });

  it("filters by brand, day window, outcome and q on a lead_id prefix or an exact click_id", async () => {
    expect(ids(await leadsAt(`/admin/leads?${WINDOW}&brand=brand-a`))).toEqual(
      ["lead-0001-newest", "lead-0002-reject", "lead-0003-pending"],
    );
    // Half-open day window: 2026-10-05T00:00:00.000Z belongs to the 5th, 23:59:59.999 to the 4th.
    expect(ids(await leadsAt("/admin/leads?from=2026-10-04&to=2026-10-04"))).toEqual(
      ["lead-0002-reject", "lead-0003-pending"],
    );
    expect(ids(await leadsAt("/admin/leads?from=2026-10-05&to=2026-10-05"))).toEqual(["lead-0001-newest"]);
    expect(ids(await leadsAt(`/admin/leads?${WINDOW}&status=sold`))).toEqual(["lead-0001-newest"]);
    expect(ids(await leadsAt(`/admin/leads?${WINDOW}&status=rejected`))).toEqual(["lead-0002-reject"]);
    expect(ids(await leadsAt(`/admin/leads?${WINDOW}&status=pending`))).toEqual([
      "lead-0003-pending", "tie-0000000003", "tie-0000000002", "tie-0000000001", "lead-0009-older",
    ]);
    expect(ids(await leadsAt(`/admin/leads?${WINDOW}&q=lead-0001`))).toEqual(["lead-0001-newest"]);
    expect(ids(await leadsAt(`/admin/leads?${WINDOW}&q=tie-`))).toEqual(
      ["tie-0000000003", "tie-0000000002", "tie-0000000001"],
    );
    expect(ids(await leadsAt(`/admin/leads?${WINDOW}&q=clk-sold-0001`))).toEqual(["lead-0001-newest"]);
    // click_id is an exact match, not a prefix.
    expect(ids(await leadsAt(`/admin/leads?${WINDOW}&q=clk-sold`))).toEqual([]);
    expect(ids(await leadsAt(`/admin/leads?${WINDOW}&brand=brand-b&status=sold`))).toEqual([]);
  });

  it("treats %, _ and backslash in q as literal characters", async () => {
    for (const q of ["%", "_", "%25%25%25%25", "\\"]) {
      const response = await lh.admin(`/admin/leads?${WINDOW}&q=${encodeURIComponent(q)}`, owner);
      expect(response.status, q).toBe(422);
      expect(await response.text()).not.toContain("lead-0001-newest");
    }
    expect(likeEscape("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    const count = async (pattern: string) => (await lh.db.prepare(
      "SELECT COUNT(*) AS n FROM leads WHERE lead_id LIKE ?1 ESCAPE '\\' AND brand IN ('brand-a', 'brand-b')",
    ).bind(pattern).first<{ n: number }>())!.n;
    expect(await count("%")).toBe(7);
    expect(await count(`${likeEscape("%")}%`)).toBe(0);
    expect(await count(`${likeEscape("_")}%`)).toBe(0);
  });

  it("returns the same bytes to an employee and an owner", async () => {
    const path = `/admin/leads?${WINDOW}&limit=4`;
    const asOwner = await (await lh.admin(path, owner)).text();
    const asEmployee = await (await lh.admin(path, employee)).text();
    expect(asEmployee).toBe(asOwner);
    LeadsResponse.parse(JSON.parse(asOwner));
    for (const hidden of [
      "Test", "Applicant", "test@example.com", "2145550123", "100 Example St", "Dallas", "75201", "1990-01-01",
      "first_name", "email", "home_phone", "birth_date", "zip", "clk-", "fixture-click",
    ]) {
      expect(asOwner, hidden).not.toContain(hidden);
    }
  });

  it("reports has_conversion and postback_count per row", async () => {
    const page = await leadsAt(`/admin/leads?${WINDOW}`);
    const byId = new Map(page.rows.map((row) => [row.lead_id, row]));
    expect(byId.get("lead-0001-newest")).toMatchObject({ has_conversion: true, postback_count: 2, outcome: "sold" });
    expect(byId.get("lead-0002-reject")).toMatchObject({ has_conversion: false, postback_count: 0, outcome: "rejected" });
    expect(byId.get("tie-0000000001")).toMatchObject({ has_conversion: false, postback_count: 0, outcome: "pending" });
  });

  it("renders a V1-era lead whose keyword, variant and experiment_id are NULL", async () => {
    const response = await lh.admin(`/admin/leads?${WINDOW}&brand=brand-b`, employee);
    const text = await response.text();
    const page = LeadsResponse.parse(JSON.parse(text));
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) expect([row.keyword, row.variant]).toEqual([null, null]);
    expect(text).not.toContain('"null"');
    const withTracking = (await leadsAt(`/admin/leads?${WINDOW}&q=lead-0001`)).rows[0]!;
    expect([withTracking.keyword, withTracking.variant]).toEqual(["Fast Cash", "a"]);
  });

  it("answers 422 on a bad cursor, a reversed window and limit 201", async () => {
    const garbage = await lh.admin(`/admin/leads?${WINDOW}&cursor=abcd`, owner);
    expect(garbage.status).toBe(422);
    expect(await garbage.json()).toMatchObject({ error: "invalid", issues: [{ path: "cursor" }] });
    expect((await lh.admin(`/admin/leads?${WINDOW}&cursor=not-a-cursor!`, owner)).status).toBe(422);
    expect((await lh.admin("/admin/leads?from=2026-10-02&to=2026-10-01", owner)).status).toBe(422);
    expect((await lh.admin(`/admin/leads?${WINDOW}&limit=201`, owner)).status).toBe(422);
    expect((await lh.admin(`/admin/leads?${WINDOW}&limit=200`, owner)).status).toBe(200);

    const cursor = encodeLeadCursor("2026-10-04T08:00:00.000Z", "lead-0003-pending");
    expect(decodeLeadCursor(cursor)).toEqual({ created_at: "2026-10-04T08:00:00.000Z", lead_id: "lead-0003-pending" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLeadCursor("abcd")).toBeNull();
    expect(decodeLeadCursor(btoa("2026-10-04|x"))).toBeNull();

    // Matches the cursor regex and the old decoder, but is not a date: it used to reach SQL.
    const notADate = "MjAyNi05OS05OVQ6WnxsZWFkLTAwMDE";
    expect(atob(notADate)).toBe("2026-99-99T:Z|lead-0001");
    expect(decodeLeadCursor(notADate)).toBeNull();
    expect(decodeLeadCursor(btoa("2026-02-31T00:00:00.000Z|lead-0001-x"))).toBeNull();
    expect(decodeLeadCursor(btoa("2026-10-04T08:00:00.000Z|short"))).toBeNull();
    const bad = await lh.admin(`/admin/leads?${WINDOW}&cursor=${notADate}`, owner);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: "invalid", issues: [{ path: "cursor" }] });
  });

  it("resolves a missing bound, then refuses a window over 93 days", async () => {
    const now = new Date("2026-10-23T12:00:00.000Z");
    expect(resolveLeadWindow({}, now)).toEqual({ from: "2026-09-24", to: "2026-10-23" });
    expect(resolveLeadWindow({ from: "2026-10-01" }, now)).toEqual({ from: "2026-10-01", to: "2026-10-23" });
    expect(resolveLeadWindow({ to: "2026-10-10" }, now)).toEqual({ from: "2026-09-11", to: "2026-10-10" });
    expect(resolveLeadWindow({ from: "2026-07-23" }, now)).toEqual({ from: "2026-07-23", to: "2026-10-23" });
    expect(resolveLeadWindow({ from: "2026-07-22" }, now)).toMatchObject({ issue: { message: "Window is longer than 93 days" } });
    expect(resolveLeadWindow({ from: "2026-10-24" }, now)).toMatchObject({ issue: { message: "from must not be after to" } });

    for (const query of ["from=2020-01-01", "from=2025-01-01"]) {
      const response = await lh.admin(`/admin/leads?${query}`, owner);
      expect(response.status, query).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "invalid", issues: [{ path: "from", message: "Window is longer than 93 days" }],
      });
    }
    // A lone `to` anywhere in history is a 30-day window ending there, not a scan of everything before it.
    // Scoped to brand-b so rows other tests seed at the real clock cannot enter the window.
    const ties = ["tie-0000000003", "tie-0000000002", "tie-0000000001"];
    expect(ids(await leadsAt("/admin/leads?brand=brand-b&to=2026-10-05"))).toEqual([...ties, "lead-0009-older"]);
    expect(ids(await leadsAt("/admin/leads?brand=brand-b&to=2026-10-31"))).toEqual(ties);
    expect(ids(await leadsAt("/admin/leads?brand=brand-b&to=2026-09-30"))).toEqual(["lead-0009-older"]);
    expect(ids(await leadsAt("/admin/leads?brand=brand-b&to=2026-08-31"))).toEqual([]);
  });

  it("defaults to the last 30 days and 50 rows", async () => {
    const stamp = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
    await lh.db.batch([
      ...Array.from({ length: 51 }, (_, i) => insert(`recent-${String(i + 1).padStart(8, "0")}`, "brand-c", stamp(1))),
      insert("stale-00000001", "brand-c", stamp(45)),
    ]);

    const first = await leadsAt("/admin/leads?brand=brand-c");
    expect(first.rows).toHaveLength(50);
    expect(first.next_cursor).not.toBeNull();
    const second = await leadsAt(`/admin/leads?brand=brand-c&cursor=${first.next_cursor}`);
    expect(second.rows).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect([...ids(first), ...ids(second)]).not.toContain("stale-00000001");
  });

  it("starts the default window 29 days before today at 00:00Z, not 28 or 30", async () => {
    const todayMs = Date.parse(new Date().toISOString().slice(0, 10));
    const at = (days: number, time: string) =>
      `${new Date(todayMs - days * DAY_MS).toISOString().slice(0, 10)}T${time}Z`;
    const fixtures = [
      ["edge-today-0001", at(0, "00:00:00.000")],
      ["edge-in-0000029", at(29, "00:00:00.000")],
      ["edge-out-000030", at(30, "23:59:59.999")],
    ] as const;
    await lh.db.batch(fixtures.map(([id, createdAt]) => insert(id, "brand-d", createdAt)));

    expect(ids(await leadsAt("/admin/leads?brand=brand-d"))).toEqual(["edge-today-0001", "edge-in-0000029"]);
  });
});

// spec leads
describe("GET /admin/leads/:lead_id (FUS-376)", () => {
  const detailId = "lead-0001-detail";
  const bareId = "lead-0002-bare";
  const WORK_PHONE = "2145550777";
  const PII_VALUES = ["Test", "Applicant", "test@example.com", "2145550123", "100 Example St", "Dallas", "75201", "1990-01-01", WORK_PHONE];
  const PII_KEYS = ['"first_name"', '"last_name"', '"birth_date"', '"email"', '"home_phone"', '"work_phone"', '"address"', '"city"', '"zip"'];
  const PII_FIELDS = ["first_name", "last_name", "birth_date", "email", "home_phone", "work_phone", "address", "city", "zip"];
  let dh: Harness;

  const auditRows = async () => Number(
    (await dh.factory.prepare("SELECT count(*) AS count FROM audit_log").first<{ count: number }>())!.count,
  );
  const read = async (id: string, context: AdminRequestContext) => {
    const response = await dh.admin(`/admin/leads/${id}`, context);
    expect(response.status, `${id} as ${context.actor_role}`).toBe(200);
    const text = await response.text();
    return { text, lead: GetLeadResponse.parse(JSON.parse(text)).lead };
  };

  beforeAll(async () => {
    dh = await createHarness();
    await dh.seedBrand("brand-a");
    await dh.seedLead(detailId, "clkdetail0001", "brand-a");
    await dh.seedLead(bareId, "clkbare0002", "brand-a");
    await dh.seedConversion(detailId, { attempts: 2, last_error: "adkit: upstream 500" });
    await dh.db.prepare("UPDATE leads SET work_phone = ?1 WHERE lead_id = ?2").bind(WORK_PHONE, detailId).run();
    await dh.db.prepare(
      "INSERT INTO postback_events (lead_id, event_type, payout, created_at) VALUES (?1, 'soldLead', 85, '2026-01-01T00:00:30.000Z')",
    ).bind(detailId).run();
  });
  afterAll(async () => { await dh?.mf.dispose(); });

  it("gives an employee the profile block and null applicant, payout and conversion value", async () => {
    const { text, lead } = await read(detailId, employee);
    expect(lead.applicant).toBeNull();
    expect(lead.profile).toEqual({
      state: "TX", address_length_months: 24, own_home: false, income_type: "EMPLOYMENT",
      employer: "Example", job_title: "Clerk", employed_months: 24, pay_date1: "2026-10-09",
      pay_frequency: "BIWEEKLY", direct_deposit: true, monthly_income: 3000,
    });
    expect(lead.postbacks).toEqual([{ event_type: "soldLead", payout: null, created_at: "2026-01-01T00:00:30.000Z" }]);
    expect(lead.conversion).toMatchObject({ status: "pending", attempts: 2, value: null, last_error: null });
    for (const hidden of [...PII_VALUES, ...PII_KEYS, "adkit: upstream 500", "fixture-click", "clkdetail0001"]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });

  it("gives an owner the applicant block and writes one pii.lead_view row naming fields only", async () => {
    const before = await auditRows();
    const { lead } = await read(detailId, owner);
    expect(lead.applicant).toMatchObject({
      first_name: "Test", last_name: "Applicant", birth_date: "1990-01-01", email: "test@example.com",
      home_phone: "2145550123", address: "100 Example St", city: "Dallas", state: "TX", zip: "75201",
    });
    expect(lead.postbacks.map((event) => event.payout)).toEqual([85]);
    expect(lead.conversion).toMatchObject({ value: 25, last_error: "adkit: upstream 500" });
    expect(await auditRows()).toBe(before + 1);

    const row = await dh.factory.prepare(
      "SELECT action, actor_id, actor_role, entity_type, entity_id, before_json, after_json FROM audit_log ORDER BY id DESC LIMIT 1",
    ).first<Record<string, string>>();
    expect([row!.action, row!.entity_type, row!.entity_id, row!.actor_id, row!.actor_role])
      .toEqual(["pii.lead_view", "lead", detailId, owner.actor_id, "owner"]);
    // A read is not a change, so there is no before-image: SQL NULL, not "{}" or "null".
    expect(row!.before_json).toBeNull();
    expect(JSON.parse(row!.after_json!)).toEqual({ fields: PII_FIELDS });
    const listed = await dh.admin(`/admin/audit?target_type=lead&target_id=${detailId}`, owner);
    const [entry] = AuditListResponse.parse(await listed.json()).entries;
    expect(AuditEntry.parse(entry)).toMatchObject({ action: "pii.lead_view", old: null, new: { fields: PII_FIELDS } });
    for (const pii of [...PII_VALUES, "fixture-click", "clkdetail0001"]) {
      expect(`${row!.before_json}${row!.after_json}`, pii).not.toContain(pii);
    }
  });

  it("writes no audit row for an employee read", async () => {
    const before = await auditRows();
    await read(detailId, employee);
    await read(bareId, employee);
    expect(await auditRows()).toBe(before);
  });

  it("reports click_type from the first present click id and never the value", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["lead-0003-wbraid", { gclid: null, wbraid: "fixture-wbraid", msclkid: "fixture-msclkid" }, "wbraid"],
      ["lead-0004-msclkid", { gclid: null, msclkid: "fixture-msclkid" }, "msclkid"],
      ["lead-0005-noclick", { gclid: null }, "none"],
    ];
    for (const [id, overrides] of cases) {
      await dh.seedLead(id, `clk${id.replace(/-/g, "")}`, "brand-a");
      await dh.seedConversion(id, overrides);
    }
    for (const context of [employee, owner]) {
      const { text, lead } = await read(detailId, context);
      expect(lead.conversion!.click_type).toBe("gclid");
      expect(text).not.toContain("fixture-click");
      for (const [id, , clickType] of cases) {
        const other = await read(id, context);
        expect(other.lead.conversion!.click_type, id).toBe(clickType);
        expect(other.text).not.toContain("fixture-");
      }
    }
  });

  it("truncates a long last_error to the contract limit for an owner", async () => {
    const original = "adkit: upstream 500";
    await dh.db.prepare("UPDATE conversion_uploads SET last_error = ?1 WHERE lead_id = ?2").bind("e".repeat(400), detailId).run();
    try {
      const { lead } = await read(detailId, owner);
      expect(lead.conversion!.last_error).toHaveLength(300);
      expect(lead.conversion!.last_error).toBe("e".repeat(300));
    } finally {
      await dh.db.prepare("UPDATE conversion_uploads SET last_error = ?1 WHERE lead_id = ?2").bind(original, detailId).run();
    }
  });

  it("returns conversion null when no upload row exists", async () => {
    for (const context of [employee, owner]) {
      const { lead } = await read(bareId, context);
      expect(lead.conversion, context.actor_role).toBeNull();
    }
  });

  it("maps an unknown conversion status to pending and keeps the raw value out", async () => {
    await dh.db.prepare("UPDATE conversion_uploads SET status = 'weird-drain-state' WHERE lead_id = ?1").bind(detailId).run();
    try {
      for (const context of [employee, owner]) {
        const { text, lead } = await read(detailId, context);
        expect(lead.conversion!.status, context.actor_role).toBe("pending");
        expect(text).not.toContain("weird");
      }
    } finally {
      await dh.db.prepare("UPDATE conversion_uploads SET status = 'pending' WHERE lead_id = ?1").bind(detailId).run();
    }
  });

  it("renders a lead whose work_phone and updated_at are NULL", async () => {
    await dh.db.prepare("UPDATE leads SET work_phone = NULL, updated_at = NULL WHERE lead_id = ?1").bind(bareId).run();
    const { text, lead } = await read(bareId, owner);
    expect(lead.applicant!.work_phone).toBeNull();
    expect(lead.updated_at).toBeNull();
    expect(text).not.toContain('"null"');
  });

  it("rejects the owner read with no PII when the audit insert fails, which the panel answers as 502", async () => {
    // Takes audit_log away for these calls only; RENAME keeps its append-only triggers for the restore.
    await dh.factory.prepare("ALTER TABLE audit_log RENAME TO audit_log_offline").run();
    let ownerResult: { response: Response | null; error: unknown } = { response: null, error: null };
    let redacted: { text: string; lead: GetLeadResponse["lead"] };
    try {
      ownerResult = await dh.admin(`/admin/leads/${detailId}`, owner)
        .then((response) => ({ response, error: null }), (error: unknown) => ({ response: null, error }));
      redacted = await read(detailId, employee);
    } finally {
      await dh.factory.prepare("ALTER TABLE audit_log_offline RENAME TO audit_log").run();
    }
    // The thrown insert error crosses the service binding as a rejected fetch; callCore maps that to 502.
    expect(ownerResult.response).toBeNull();
    expect(ownerResult.error).toBeInstanceOf(Error);
    const error = ownerResult.error as Error;
    expect(error.message).toContain("audit_log");
    for (const hidden of [...PII_VALUES, ...PII_KEYS, "fixture-click"]) {
      expect(`${error.message}\n${error.stack ?? ""}`, hidden).not.toContain(hidden);
    }
    expect(redacted!.lead.applicant).toBeNull();
    expect(redacted!.lead.profile.state).toBe("TX");
  });
});

// spec leads
describe("GET /admin/leads/export (FUS-376)", () => {
  const WINDOW = "from=2026-10-01&to=2026-10-31";
  const PII_VALUES = ["Test", "Applicant", "test@example.com", "2145550123", "100 Example St", "Dallas", "75201", "1990-01-01"];
  const PII_KEYS = ['"first_name"', '"last_name"', '"birth_date"', '"email"', '"home_phone"', '"work_phone"', '"address"', '"city"', '"zip"'];
  const CLICK_VALUES = ["fixture-click", "clkexpsold0001", "clkexppend0002", "clkexpv1era0003", "clkexpbrandb0004"];
  let xh: Harness;

  const auditRows = async () => Number(
    (await xh.factory.prepare("SELECT count(*) AS count FROM audit_log").first<{ count: number }>())!.count,
  );
  const lastAudit = () => xh.factory.prepare(
    "SELECT action, actor_id, actor_role, entity_type, entity_id, before_json, after_json FROM audit_log ORDER BY id DESC LIMIT 1",
  ).first<Record<string, string | null>>();
  const exportAs = async (query: string, context: AdminRequestContext) => {
    const response = await xh.admin(`/admin/leads/export?${query}`, context);
    expect(response.status, `${query} as ${context.actor_role}`).toBe(200);
    const text = await response.text();
    return { text, body: LeadExportResponse.parse(JSON.parse(text)) };
  };

  beforeAll(async () => {
    xh = await createHarness();
    for (const brand of ["brand-a", "brand-b"]) await xh.seedBrand(brand);
    const seed = async (id: string, click: string, brand: string, createdAt: string, status: string) => {
      await xh.seedLead(id, click, brand);
      await xh.db.prepare("UPDATE leads SET created_at = ?1, status = ?2 WHERE lead_id = ?3")
        .bind(createdAt, status, id).run();
    };
    await seed("exp-0001-sold", "clkexpsold0001", "brand-a", "2026-10-05T00:00:00.000Z", "soldLead");
    await seed("exp-0002-pending", "clkexppend0002", "brand-a", "2026-10-04T00:00:00.000Z", "newLead");
    await seed("exp-0003-v1era", "clkexpv1era0003", "brand-a", "2026-10-03T00:00:00.000Z", "rejectLead");
    await seed("exp-0004-brandb", "clkexpbrandb0004", "brand-b", "2026-10-02T00:00:00.000Z", "newLead");
    await xh.db.prepare(
      "UPDATE leads SET keyword = 'Fast Cash', variant = 'A', experiment_id = 'exp-2026-10', work_phone = '2145550999' WHERE lead_id = 'exp-0001-sold'",
    ).run();
    // A V1-era row: the 0003 columns and work_phone were never written.
    await xh.db.prepare(
      "UPDATE leads SET keyword = NULL, variant = NULL, experiment_id = NULL, work_phone = NULL WHERE lead_id = 'exp-0003-v1era'",
    ).run();
    await xh.seedConversion("exp-0001-sold");
    await xh.db.prepare(
      "INSERT INTO postback_events (lead_id, event_type, payout, created_at) VALUES ('exp-0001-sold', 'soldLead', 85, '2026-10-05T00:00:30.000Z')",
    ).run();
  });
  afterAll(async () => { await xh?.mf.dispose(); });

  it("is 403 forbidden_role for an employee who asks for pii=1 and 200 without it", async () => {
    const before = await auditRows();
    const denied = await xh.admin(`/admin/leads/export?${WINDOW}&pii=1`, employee);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "forbidden_role", required_role: "owner", denied_fields: ["pii"], request_id: employee.request_id,
    });
    expect(await auditRows()).toBe(before);
    // The query parses before the role check, so a bad filter is 422 even with pii=1.
    expect((await xh.admin("/admin/leads/export?from=2026-10-02&to=2026-10-01&pii=1", employee)).status).toBe(422);
    expect((await xh.admin(`/admin/leads/export?${WINDOW}&pii=yes`, employee)).status).toBe(422);

    for (const query of [WINDOW, `${WINDOW}&pii=0`]) {
      const { text, body } = await exportAs(query, employee);
      expect(body.pii).toBe(false);
      expect(body.rows.map((row) => row.lead_id)).toEqual(["exp-0001-sold", "exp-0002-pending", "exp-0003-v1era", "exp-0004-brandb"]);
      for (const row of body.rows) expect(Object.keys(row)).toEqual([...LEAD_EXPORT_COLUMNS]);
      for (const hidden of [...PII_VALUES, ...PII_KEYS, "2145550999"]) expect(text, hidden).not.toContain(hidden);
    }
  });

  it("returns the PII columns to an owner and writes pii.lead_export with filters and a row count", async () => {
    const before = await auditRows();
    const { body } = await exportAs(`${WINDOW}&brand=brand-a&pii=1`, owner);
    expect(body.pii).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.rows.map((row) => row.lead_id)).toEqual(["exp-0001-sold", "exp-0002-pending", "exp-0003-v1era"]);
    for (const row of body.rows) expect(Object.keys(row)).toEqual([...LEAD_EXPORT_PII_COLUMNS]);
    expect(body.rows[0]).toMatchObject({
      first_name: "Test", last_name: "Applicant", birth_date: "1990-01-01", email: "test@example.com",
      home_phone: "2145550123", work_phone: "2145550999", address: "100 Example St", city: "Dallas", zip: "75201",
      state: "TX", own_home: false, direct_deposit: true, monthly_income: 3000,
      has_conversion: true, postback_count: 1, outcome: "sold",
    });
    expect(await auditRows()).toBe(before + 1);

    const row = await lastAudit();
    expect([row!.action, row!.entity_type, row!.entity_id, row!.actor_id, row!.actor_role])
      .toEqual(["pii.lead_export", "lead_export", "2026-10-01..2026-10-31:brand-a", owner.actor_id, "owner"]);
    expect(row!.before_json).toBeNull();
    expect(JSON.parse(row!.after_json!)).toEqual({
      rows: 3, truncated: false, pii: true,
      filters: { brand: "brand-a", from: "2026-10-01", to: "2026-10-31", status: null, q: null },
    });
    for (const hidden of [...PII_VALUES, "2145550999", ...CLICK_VALUES]) {
      expect(row!.after_json, hidden).not.toContain(hidden);
    }
    const listed = await xh.admin("/admin/audit?target_type=lead_export", owner);
    const [entry] = AuditListResponse.parse(await listed.json()).entries;
    expect(AuditEntry.parse(entry)).toMatchObject({
      action: "pii.lead_export", target: { type: "lead_export", id: "2026-10-01..2026-10-31:brand-a" }, old: null,
    });
  });

  it("writes lead.export, not pii.lead_export, for a non-PII download", async () => {
    for (const context of [employee, owner]) {
      const before = await auditRows();
      const { text, body } = await exportAs(`${WINDOW}&status=pending`, context);
      expect(body.pii).toBe(false);
      expect(body.rows.map((r) => r.lead_id)).toEqual(["exp-0002-pending", "exp-0004-brandb"]);
      for (const hidden of PII_KEYS) expect(text, `${context.actor_role} ${hidden}`).not.toContain(hidden);
      expect(await auditRows()).toBe(before + 1);
      const row = await lastAudit();
      expect([row!.action, row!.entity_type, row!.entity_id, row!.actor_id])
        .toEqual(["lead.export", "lead_export", "2026-10-01..2026-10-31:all", context.actor_id]);
      expect(row!.before_json).toBeNull();
      expect(JSON.parse(row!.after_json!)).toEqual({
        rows: 2, truncated: false, pii: false,
        filters: { brand: null, from: "2026-10-01", to: "2026-10-31", status: "pending", q: null },
      });
    }
  });

  it("sets truncated and returns only the newest rows when more matched", async () => {
    const page = (await exportAs(`${WINDOW}&limit=2`, owner)).body;
    expect(page.rows).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect(page.rows.map((row) => row.lead_id)).toEqual(["exp-0001-sold", "exp-0002-pending"]);
    expect(JSON.parse((await lastAudit())!.after_json!)).toMatchObject({ rows: 2, truncated: true, pii: false });

    const exact = (await exportAs(`${WINDOW}&limit=4`, owner)).body;
    expect([exact.rows.length, exact.truncated]).toEqual([4, false]);
    const full = (await exportAs(WINDOW, owner)).body;
    expect([full.rows.length, full.truncated]).toEqual([4, false]);
    expect((await xh.admin(`/admin/leads/export?${WINDOW}&limit=5001`, owner)).status).toBe(422);
  });

  it("exports a V1-era lead with NULL keyword and work_phone as nulls", async () => {
    for (const query of [`${WINDOW}&q=exp-0003`, `${WINDOW}&q=exp-0003&pii=1`]) {
      const { text, body } = await exportAs(query, owner);
      expect(body.rows).toHaveLength(1);
      const [row] = body.rows;
      expect(row!.lead_id).toBe("exp-0003-v1era");
      expect([row!.keyword, row!.variant]).toEqual([null, null]);
      if (body.pii) expect(row!.work_phone).toBeNull();
      expect(text).not.toContain('"null"');
    }
  });

  it("never includes click_id or a click id value in an export row", async () => {
    for (const [query, context] of [[WINDOW, employee], [WINDOW, owner], [`${WINDOW}&pii=1`, owner]] as const) {
      const { text, body } = await exportAs(query, context);
      expect(body.rows.length).toBe(4);
      for (const hidden of [...CLICK_VALUES, '"click_id"', '"gclid"', '"gbraid"', '"wbraid"', '"msclkid"']) {
        expect(text, `${query} ${hidden}`).not.toContain(hidden);
      }
    }
    // q matches click_id exactly; the matched value still does not come back.
    const { text, body } = await exportAs(`${WINDOW}&q=clkexpsold0001&pii=1`, owner);
    expect(body.rows.map((row) => row.lead_id)).toEqual(["exp-0001-sold"]);
    expect(text).not.toContain("clkexpsold0001");

    // The audit row keeps the actor's own query string as typed, and no click value seeded by the harness.
    const audit = await lastAudit();
    expect(audit!.action).toBe("pii.lead_export");
    const after = JSON.parse(audit!.after_json!);
    expect(after.filters.q).toBe("clkexpsold0001");
    for (const hidden of ["fixture-click", "gclid", "click_id"]) {
      expect(audit!.after_json, hidden).not.toContain(hidden);
    }
  });

  it("audits the resolved 30-day window when from and to are absent", async () => {
    const today = () => new Date().toISOString().slice(0, 10);
    const first = today();
    await exportAs("", owner);
    const last = today();
    const audit = await lastAudit();
    const { filters } = JSON.parse(audit!.after_json!) as { filters: { from: string | null; to: string | null } };
    expect(filters.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(filters.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Two reads of the clock bracket the handler's own, so a midnight crossing cannot flake this.
    expect([first, last]).toContain(filters.to);
    const days = (Date.parse(filters.to!) - Date.parse(filters.from!)) / 86_400_000 + 1;
    expect(days).toBe(30);
    expect(audit!.entity_id).toBe(`${filters.from}..${filters.to}:all`);
  });

  it("returns no PII body when the export audit insert fails", async () => {
    await xh.factory.prepare("ALTER TABLE audit_log RENAME TO audit_log_offline").run();
    let outcome: { status: number | null; text: string };
    try {
      outcome = await xh.admin(`/admin/leads/export?${WINDOW}&pii=1`, owner).then(
        async (response) => ({ status: response.status, text: await response.text() }),
        (error: unknown) => ({ status: null, text: `${(error as Error).message}\n${(error as Error).stack ?? ""}` }),
      );
    } finally {
      await xh.factory.prepare("ALTER TABLE audit_log_offline RENAME TO audit_log").run();
    }
    expect(outcome!.status).not.toBe(200);
    for (const hidden of [...PII_VALUES, "2145550999"]) expect(outcome!.text, hidden).not.toContain(hidden);
  });
});

describe("GET /admin/suppressions (FUS-376)", () => {
  const SEEDED = [
    "100%_off@promo.example",
    "alice@example.com",
    "bob@example.com",
    "carol@test.example",
    "dave@example.com",
    "o\\brien@example.com",
  ];
  let sh: Harness;

  const auditRows = async () => Number(
    (await sh.factory.prepare("SELECT count(*) AS count FROM audit_log").first<{ count: number }>())!.count,
  );
  const lastAudit = () => sh.factory.prepare(
    "SELECT action, actor_id, actor_role, entity_type, entity_id, before_json, after_json FROM audit_log ORDER BY id DESC LIMIT 1",
  ).first<Record<string, string | null>>();
  const search = async (query: string, context: AdminRequestContext = owner) => {
    const response = await sh.admin(`/admin/suppressions${query ? `?${query}` : ""}`, context);
    expect(response.status, query).toBe(200);
    return SuppressionsResponse.parse(await response.json());
  };
  const emails = (page: SuppressionsResponse) => page.rows.map((row) => row.email);
  const cursorOf = (email: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(email))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  beforeAll(async () => {
    sh = await createHarness();
    const seed = async (email: string, reason: string, source: string, createdAt: string, updatedAt: string | null) => {
      await sh.db.prepare(
        "INSERT INTO suppressions (email, reason, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(email, reason, source, createdAt, updatedAt).run();
    };
    await seed("alice@example.com", "blocklisted", "listmonk", "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z");
    await seed("bob@example.com", "unsubscribed", "listmonk", "2026-10-01T00:00:00.000Z", null);
    await seed("carol@test.example", "bounce", "ses", "2026-10-03T00:00:00.000Z", null);
    await seed("100%_off@promo.example", "complaint", "manual", "2026-10-04T00:00:00.000Z", null);
    await seed("dave@example.com", "manual", "manual", "2026-10-05T00:00:00.000Z", null);
    await seed("o\\brien@example.com", "manual", "manual", "2026-10-06T00:00:00.000Z", null);
  });
  afterAll(async () => { await sh?.mf.dispose(); });

  it("is 403 forbidden_role for an employee", async () => {
    const before = await auditRows();
    for (const query of ["", "q=alice", "limit=0", "reason=spam", "cursor=@@@"]) {
      const denied = await sh.admin(`/admin/suppressions${query ? `?${query}` : ""}`, employee);
      expect(denied.status, query).toBe(403);
      const text = await denied.text();
      expect(JSON.parse(text), query).toEqual({
        error: "forbidden_role", required_role: "owner", request_id: employee.request_id,
      });
      for (const hidden of SEEDED) expect(text, hidden).not.toContain(hidden);
    }
    expect(await auditRows()).toBe(before);
  });

  it("searches by q as a substring, by reason and by source", async () => {
    expect(emails(await search(""))).toEqual(SEEDED);
    expect(emails(await search("q=example.com"))).toEqual([
      "alice@example.com", "bob@example.com", "dave@example.com", "o\\brien@example.com",
    ]);
    expect(emails(await search("q=b"))).toEqual(["bob@example.com", "o\\brien@example.com"]);
    expect(emails(await search("reason=bounce"))).toEqual(["carol@test.example"]);
    expect(emails(await search("reason=manual"))).toEqual(["dave@example.com", "o\\brien@example.com"]);
    expect(emails(await search("source=listmonk"))).toEqual(["alice@example.com", "bob@example.com"]);
    expect(emails(await search("source=manual&q=example.com"))).toEqual(["dave@example.com", "o\\brien@example.com"]);
    expect(emails(await search("reason=bounce&source=listmonk"))).toEqual([]);

    const page = await search("q=alice");
    expect(page).toEqual({
      rows: [{
        email: "alice@example.com", reason: "blocklisted", source: "listmonk",
        created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z",
      }],
      next_cursor: null,
    });
    expect((await search("q=bob")).rows[0]!.updated_at).toBeNull();
  });

  it("lowercases q and treats %, _ and \\ as literal characters", async () => {
    expect(emails(await search("q=ALICE@"))).toEqual(["alice@example.com"]);
    expect(emails(await search("q=E@"))).toEqual(["alice@example.com", "dave@example.com"]);

    // Each of these would match all six rows if it were a wildcard. Each matches only the one address that holds the character.
    expect(emails(await search("q=%25"))).toEqual(["100%_off@promo.example"]);
    expect(emails(await search("q=_"))).toEqual(["100%_off@promo.example"]);
    expect(emails(await search("q=%5C"))).toEqual(["o\\brien@example.com"]);
    // Literal pairs that no address holds return nothing, not the whole column.
    expect(emails(await search("q=%25%25"))).toEqual([]);
    expect(emails(await search("q=%25a"))).toEqual([]);
    expect(emails(await search("q=__"))).toEqual([]);
    expect(emails(await search("q=_%25"))).toEqual([]);
    expect(emails(await search("q=%5C%25"))).toEqual([]);
    expect(emails(await search("q=a%25%25@"))).toEqual([]);
    expect(emails(await search("q=%25_off"))).toEqual(["100%_off@promo.example"]);
    expect(emails(await search("q=%25%5F"))).toEqual(["100%_off@promo.example"]);
  });

  it("pages ascending by email with no overlap", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    const cursors: Array<string | null> = [];
    do {
      const page: SuppressionsResponse = await search(`limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      sizes.push(page.rows.length);
      cursors.push(page.next_cursor);
      seen.push(...emails(page));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(SEEDED);
    expect(sizes).toEqual([2, 2, 2]);
    expect(cursors[0]).toBe(cursorOf("alice@example.com"));
    expect(cursors[1]).toBe(cursorOf("carol@test.example"));
    expect(cursors[2]).toBeNull();

    // Filters and the cursor combine.
    const filtered = await search(`q=example.com&limit=2&cursor=${cursorOf("alice@example.com")}`);
    expect(emails(filtered)).toEqual(["bob@example.com", "dave@example.com"]);
    expect(filtered.next_cursor).toBe(cursorOf("dave@example.com"));
    expect(emails(await search(`q=example.com&limit=2&cursor=${filtered.next_cursor}`))).toEqual(["o\\brien@example.com"]);
    expect((await search("limit=6")).next_cursor).toBeNull();
    expect((await search("limit=5")).next_cursor).toBe(cursorOf("dave@example.com"));
  });

  it("is 422 invalid for a cursor that is not a stored-email shape, and writes no audit row", async () => {
    const before = await auditRows();
    const bad = [
      "@@@",
      cursorOf("\u0000"),
      cursorOf("a b@example.com"),
      cursorOf("a\nb@example.com"),
      cursorOf("a".repeat(255)),
      "_w", // the single byte 0xFF, which is not UTF-8
    ];
    for (const cursor of bad) {
      const response = await sh.admin(`/admin/suppressions?cursor=${cursor}`, owner);
      expect(response.status, cursor).toBe(422);
      expect(await response.json(), cursor).toMatchObject({ error: "invalid" });
    }
    expect((await sh.admin("/admin/suppressions?reason=spam", owner)).status).toBe(422);
    expect((await sh.admin("/admin/suppressions?q=", owner)).status).toBe(422);
    expect(await auditRows()).toBe(before);
  });

  it("writes one pii.suppression_search row with the query and the count and no email", async () => {
    const before = await auditRows();
    const page = await search("q=EXAMPLE.com&reason=manual&source=manual&limit=1");
    expect(page.rows).toHaveLength(1);
    expect(await auditRows()).toBe(before + 1);

    const row = await lastAudit();
    expect([row!.action, row!.entity_type, row!.entity_id, row!.actor_id, row!.actor_role])
      .toEqual(["pii.suppression_search", "suppression", "search", owner.actor_id, "owner"]);
    expect(row!.before_json).toBeNull();
    // `q` is the actor's own input, kept as typed. `rows` counts the page returned, not the extra look-ahead row.
    expect(JSON.parse(row!.after_json!)).toEqual({ q: "EXAMPLE.com", reason: "manual", source: "manual", rows: 1 });
    for (const email of SEEDED) expect(row!.after_json, email).not.toContain(email);

    await search("");
    expect(JSON.parse((await lastAudit())!.after_json!)).toEqual({ q: null, reason: null, source: null, rows: 6 });
    await search("q=%25");
    expect(JSON.parse((await lastAudit())!.after_json!)).toEqual({ q: "%", reason: null, source: null, rows: 1 });
    await search("q=nobody-matches-this");
    expect(JSON.parse((await lastAudit())!.after_json!)).toMatchObject({ rows: 0 });
    expect(await auditRows()).toBe(before + 4);

    const listed = await sh.admin("/admin/audit?target_type=suppression", owner);
    const [entry] = AuditListResponse.parse(await listed.json()).entries;
    expect(AuditEntry.parse(entry)).toMatchObject({
      action: "pii.suppression_search", target: { type: "suppression", id: "search" }, old: null,
    });
  });

  it("returns no addresses when the audit insert fails", async () => {
    await sh.factory.prepare("ALTER TABLE audit_log RENAME TO audit_log_offline").run();
    let outcome: { status: number | null; text: string };
    try {
      outcome = await sh.admin("/admin/suppressions", owner).then(
        async (response) => ({ status: response.status, text: await response.text() }),
        (error: unknown) => ({ status: null, text: `${(error as Error).message}\n${(error as Error).stack ?? ""}` }),
      );
    } finally {
      await sh.factory.prepare("ALTER TABLE audit_log_offline RENAME TO audit_log").run();
    }
    expect(outcome!.status).not.toBe(200);
    for (const email of SEEDED) expect(outcome!.text, email).not.toContain(email);
  });
});

describe("GET /admin/suppressions with non-ASCII addresses (FUS-376)", () => {
  // 142 characters, 272 UTF-8 bytes: its base64url cursor is 363 characters, over the 344 a lead cursor allows.
  const LONG = `${"é".repeat(130)}@example.com`;
  const SEEDED = ["a@example.com", "b@example.com", LONG, "ê@example.com", "ü@example.com", "élodie@example.com"].sort(
    (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  let sh: Harness;

  const search = async (query: string) => {
    const response = await sh.admin(`/admin/suppressions?${query}`, owner);
    expect(response.status, query).toBe(200);
    return SuppressionsResponse.parse(await response.json());
  };
  const emails = (page: SuppressionsResponse) => page.rows.map((row) => row.email);

  beforeAll(async () => {
    sh = await createHarness();
    for (const email of SEEDED) {
      await sh.db.prepare(
        "INSERT INTO suppressions (email, reason, source, created_at, updated_at) VALUES (?1, 'manual', 'manual', '2026-10-01T00:00:00.000Z', NULL)",
      ).bind(email).run();
    }
  });
  afterAll(async () => { await sh?.mf.dispose(); });

  it("pages past a long non-ASCII address without a 422", async () => {
    const limit = SEEDED.indexOf(LONG) + 1;
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(SEEDED.length);

    const first = await search(`limit=${limit}`);
    expect(emails(first).at(-1)).toBe(LONG);
    expect(first.next_cursor).not.toBeNull();
    expect(first.next_cursor!.length).toBeGreaterThan(344);

    const second = await search(`limit=${limit}&cursor=${first.next_cursor}`);
    expect(second.rows.length).toBeGreaterThan(0);
    expect(emails(second).filter((email) => emails(first).includes(email))).toEqual([]);
    expect([...emails(first), ...emails(second)]).toEqual(SEEDED);
  });

  it("lowercases q in JavaScript, because SQLite LIKE folds only ASCII case", async () => {
    expect(emails(await search("q=%C3%89"))).toEqual(
      SEEDED.filter((email) => email.includes("é")),
    );
    expect(emails(await search("q=%C3%89LODIE"))).toEqual(["élodie@example.com"]);
  });
});
