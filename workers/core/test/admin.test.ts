import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuditListResponse,
  BrandPatchResponse,
  BrandStatusChangeResponse,
  GetBrandResponse,
  GetLeadResponse,
  LeadAggregatesResponse,
  ListBrandsResponse,
  type AdminRequestContext,
} from "@anjuna/contracts";
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
  it("round-trips every read endpoint through its contract schema", async () => {
    const list = await h.admin("/admin/brands", employee);
    expect(list.status).toBe(200);
    const listed = ListBrandsResponse.parse(await list.json());
    expect(listed.brands).toHaveLength(2);
    expect(listed.brands[0]!.ab_config!.variants.map((variant) => variant.id)).toEqual(["a", "b"]);
    expect(listed.brands[0]!.form_version).toBeNull();
    expect(listed.brands[0]!.stats_7d).toEqual({ leads: 1, sold: 1, pending: 0 });

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
    expect(detail.applicant.email).toBe("test@example.com");

    const audit = await h.admin("/admin/audit", owner);
    expect(AuditListResponse.parse(await audit.json()).entries).toEqual([]);
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
    const pii = await h.admin("/admin/leads/not-found-but-valid", employee);
    expect(pii.status).toBe(403);
    expect(await pii.json()).toEqual({
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
    const denied = await h.admin(`/admin/leads/${leadId}`, employee);
    expect(denied.status).toBe(403);
    const allowed = GetLeadResponse.parse(await (await h.admin(`/admin/leads/${leadId}`, owner)).json());
    expect(allowed.lead.applicant.first_name).toBe("Test");

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
    for (const path of ["/admin/brands", `/admin/leads/${leadId}`, "/admin/audit"]) {
      const response = await h.request(path);
      expect([response.status, await response.text()]).toEqual([404, "Not Found"]);
    }
  });
});
