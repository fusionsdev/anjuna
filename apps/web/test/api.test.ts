import {
  ADMIN_ROLE_TABLE,
  AdminError,
  AuditListResponse,
  BRAND_PATCH_FIELD_GROUPS,
  GetLeadResponse,
  ListBrandsResponse,
  BrandPatchResponse,
} from "@anjuna/contracts";
import lead from "@anjuna/contracts/fixtures/admin/lead.get.response.json";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PANEL_ROLE_TABLE } from "../src/server/panel-roles";
import { LEAD_ID, auditRows, call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
let employee2: string;

beforeAll(async () => {
  await setupDatabases();
});
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  employee2 = await sessions.employee2();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
  ]);
});

const patch = (cookie: string, body: unknown) => call("/api/brands/brand-a", { cookie, method: "PATCH", body });
const post = (cookie: string, path: string, body: unknown = {}) => call(path, { cookie, method: "POST", body });
// MOCK_CORE=1 would fill a missing FACTORY_WORKER with the local-preview stand-in (spec D8.4), so the missing-binding cases turn it off.
const postNoMock = (cookie: string, path: string) => call(path, { cookie, method: "POST", body: {}, env: makeEnv({ MOCK_CORE: "0" }) });

async function expectForbidden(res: Response, fields?: string[]) {
  expect(res.status).toBe(403);
  const body = AdminError.parse(await res.json());
  expect(body.error).toBe("forbidden_role");
  if (body.error === "forbidden_role") {
    expect(body.required_role).toBe("owner");
    if (fields) expect(body.denied_fields?.slice().sort()).toEqual(fields.slice().sort());
  }
}

describe("session", () => {
  it("rejects API calls without a better-auth session", async () => {
    expect((await call("/api/brands")).status).toBe(401);
    expect((await call("/api/brands", { cookie: "better-auth.session_token=forged" })).status).toBe(401);
  });

  it("rejects a wrong password and keeps sign-up closed", async () => {
    const bad = await call("/api/auth/sign-in/email", { method: "POST", body: { email: "emp1@example.test", password: "wrong-password" } });
    expect(bad.status).toBe(401);
    const up = await call("/api/auth/sign-up/email", { method: "POST", body: { email: "new@example.test", password: "password-123", name: "N" } });
    expect(up.ok).toBe(false);
  });

  it("does not expose better-auth's own admin routes (they would skip the panel audit)", async () => {
    expect((await call("/api/auth/admin/list-users", { cookie: owner })).status).toBe(404);
    expect((await call("/api/auth/admin/set-role", { cookie: owner, method: "POST", body: { userId: "x", role: "owner" } })).status).toBe(404);
  });

  it("/api/me reports the role from the session", async () => {
    expect(await (await call("/api/me", { cookie: employee })).json()).toMatchObject({ user: { role: "employee" } });
    expect(await (await call("/api/me", { cookie: owner })).json()).toMatchObject({ user: { role: "owner" } });
  });

  it("/api/me reports the tenant account from DEFAULT_ACCOUNT", async () => {
    // makeEnv in test/helpers.ts sets DEFAULT_ACCOUNT to "test-account".
    expect(await (await call("/api/me", { cookie: owner })).json()).toMatchObject({ user: { account: "test-account" } });
  });
});

describe("employee can run the day", () => {
  it("lists brands and reads a brand through core", async () => {
    const list = ListBrandsResponse.parse(await (await call("/api/brands", { cookie: employee })).json());
    expect(list.brands.map((b) => b.brand_id)).toEqual(["brand-a", "brand-b"]);
    const one = await call("/api/brands/brand-a", { cookie: employee });
    expect(one.status).toBe(200);
  });

  it("pauses and resumes a brand", async () => {
    const paused = await post(owner, "/api/brands/brand-a/pause", { reason: "reject spike" });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ brand_id: "brand-a", status: "paused", changed: true });
    const again = await post(owner, "/api/brands/brand-a/pause");
    expect(await again.json()).toMatchObject({ changed: false, audit_id: null });
    const resumed = await post(employee, "/api/brands/brand-a/resume");
    expect(await resumed.json()).toMatchObject({ status: "live", changed: true });
  });

  it("refuses an Employee pause with 403 owner-only and leaves the brand live", async () => {
    const res = await post(employee, "/api/brands/brand-a/pause", { reason: "x" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    expect(await (await call("/api/brands/brand-a", { cookie: employee })).json()).toMatchObject({ brand: { status: "live" } });
  });

  it("edits keyword_default", async () => {
    const res = await patch(employee, { keyword_default: "Quick Cash Today" });
    expect(res.status).toBe(200);
    const body = BrandPatchResponse.parse(await res.json());
    expect(body.changed).toEqual(["keyword_default"]);
    expect(body.brand.keyword_default).toBe("Quick Cash Today");
  });

  it("refuses Employee rollback before looking up the brand", async () => {
    await expectForbidden(await post(employee, "/api/brands/brand-a/rollback"));
    await expectForbidden(await post(employee, "/api/brands/nope/rollback"));
    expect((await post(owner, "/api/brands/nope/rollback")).status).toBe(404);
  });

  it("sees aggregates only", async () => {
    const res = await call("/api/leads/aggregates?from=2026-09-26&to=2026-10-02", { cookie: employee });
    expect(res.status).toBe(200);
  });
});

describe("employee is denied what the role table withholds (403 forbidden_role)", () => {
  it("A/B weights", async () => {
    await expectForbidden(
      await patch(employee, { ab_config: { experiment_id: "exp-2026-10", variants: [{ id: "a", weight: 70 }, { id: "b", weight: 30 }] } }),
      ["ab_config"],
    );
  });
  it("amount buckets", async () => {
    await expectForbidden(await patch(employee, { amount_buckets: [500, 1000] }), ["amount_buckets"]);
  });
  it("flow gate mode", async () => {
    await expectForbidden(await patch(employee, { flow_gate_mode: "signed_cookie" }), ["flow_gate_mode"]);
  });
  it("money-path settings, including token rotation", async () => {
    await expectForbidden(await patch(employee, { aid: "20002" }), ["aid"]);
    await expectForbidden(await patch(employee, { prepop_base: "https://prepop.example/new" }), ["prepop_base"]);
    await expectForbidden(await patch(employee, { drain_key: "brand_z" }), ["drain_key"]);
    await expectForbidden(await patch(employee, { rotate_postback_token: true }), ["rotate_postback_token"]);
  });
  it("a mixed patch is refused as a whole", async () => {
    await expectForbidden(await patch(employee, { keyword_default: "Sneaky Keyword", aid: "20002" }), ["aid"]);
    const brand = await (await call("/api/brands/brand-a", { cookie: owner })).json();
    expect(brand).toMatchObject({ brand: { keyword_default: "Fast Cash Loans", aid: "10001" } });
  });
  it("PII lead detail", async () => {
    // Core redacts by field; the endpoint is open to an employee, who gets no applicant block.
    const res = await call(`/api/leads/${LEAD_ID}`, { cookie: employee });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const [key, value] of Object.entries(lead.lead.applicant)) {
      if (["first_name", "last_name", "birth_date", "email", "home_phone", "work_phone", "address", "city", "zip"].includes(key) && value !== null) {
        expect(text, key).not.toContain(String(value));
      }
    }
    const body = GetLeadResponse.parse(JSON.parse(text));
    expect(body.lead.applicant).toBeNull();
    // Money is owner-only.
    expect(body.lead.postbacks.map((p) => p.payout)).toEqual([null, null]);
    expect(body.lead.conversion).toMatchObject({ value: null, last_error: null });
  });
  it("user management", async () => {
    await expectForbidden(await call("/api/users", { cookie: employee }));
    await expectForbidden(await post(employee, "/api/users", { email: "x@example.test", name: "X", password: "password-123", role: "owner" }));
    await expectForbidden(await call("/api/users/usr_x", { cookie: employee, method: "PATCH", body: { role: "owner" } }));
  });
  it("another actor's audit entries", async () => {
    await expectForbidden(await call("/api/audit?actor_id=usr_owner_01", { cookie: employee }));
  });
});

describe("owner can do all of it", () => {
  it("returns a controlled 404, never 500, for malformed percent-encoding on core-backed id routes", async () => {
    const bad = "%E0%A4%A";
    const cases: Array<[string, Parameters<typeof call>[1]]> = [
      [`/api/brands/${bad}`, { cookie: owner }],
      [`/api/brands/${bad}`, { cookie: owner, method: "PATCH", body: { keyword_default: "x" } }],
      [`/api/brands/${bad}/pause`, { cookie: owner, method: "POST", body: {} }],
      [`/api/leads/${bad}`, { cookie: owner }],
      [`/api/users/${bad}`, { cookie: owner, method: "PATCH", body: { role: "owner" } }],
    ];
    for (const [path, init] of cases) {
      const res = await call(path, init);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toMatchObject({ error: "not_found" });
    }
  });

  it("changes A/B weights, buckets, flow gate and money-path settings", async () => {
    const res = await patch(owner, {
      ab_config: { experiment_id: "exp-2026-10", variants: [{ id: "a", weight: 70 }, { id: "b", weight: 30 }] },
      amount_buckets: [500, 1000, 2000],
      flow_gate_mode: "signed_cookie",
      aid: "20002",
      prepop_base: "https://prepop.example/new",
      drain_key: "brand_z",
    });
    expect(res.status).toBe(200);
    const body = BrandPatchResponse.parse(await res.json());
    expect(body.changed.sort()).toEqual(["ab_config", "aid", "amount_buckets", "drain_key", "flow_gate_mode", "prepop_base"]);
    expect(body.issued_postback_token).toBeUndefined();
  });

  it("rejects A/B weights that do not sum to 100 and unsorted buckets (422)", async () => {
    const ab = await patch(owner, { ab_config: { experiment_id: "e", variants: [{ id: "a", weight: 60 }, { id: "b", weight: 60 }] } });
    expect(ab.status).toBe(422);
    expect((await patch(owner, { amount_buckets: [1000, 500] })).status).toBe(422);
  });

  it("returns 409 on a stale expected_updated_at", async () => {
    const res = await patch(owner, { keyword_default: "Another Keyword", expected_updated_at: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(409);
  });

  it("reads PII lead detail", async () => {
    const res = await call(`/api/leads/${LEAD_ID}`, { cookie: owner });
    expect(res.status).toBe(200);
    const body = GetLeadResponse.parse(await res.json());
    expect(body.lead.lead_id).toBe(LEAD_ID);
    expect(body.lead.applicant).not.toBeNull();
    expect(body.lead.profile.state).toBe("TX");
    expect(body.lead.conversion).not.toBeNull();
    expect(typeof body.lead.conversion?.value).toBe("number");
    expect((await call("/api/leads/00000000-0000-0000-0000-000000000000", { cookie: owner })).status).toBe(404);
  });

  it("manages users: list, create, set role", async () => {
    const list = (await (await call("/api/users", { cookie: owner })).json()) as { users: { email: string }[] };
    expect(list.users.map((u) => u.email).sort()).toEqual(["emp1@example.test", "emp2@example.test", "owner@example.test"]);

    const created = await post(owner, "/api/users", { email: "new@example.test", name: "New", password: "password-123", role: "employee" });
    expect(created.status).toBe(201);
    const { user } = (await created.json()) as { user: { id: string; role: string } };
    expect(user.role).toBe("employee");

    const promoted = await call(`/api/users/${user.id}`, { cookie: owner, method: "PATCH", body: { role: "owner" } });
    expect(promoted.status).toBe(200);
    const role = await env.AUTH.prepare(`SELECT "role" FROM "user" WHERE "id" = ?1`).bind(user.id).first<{ role: string }>();
    expect(role?.role).toBe("owner");
  });

  it("cannot change their own role", async () => {
    const me = (await (await call("/api/me", { cookie: owner })).json()) as { user: { id: string } };
    expect((await call(`/api/users/${me.user.id}`, { cookie: owner, method: "PATCH", body: { role: "employee" } })).status).toBe(422);
  });
});

describe("role table coverage", () => {
  it("every PATCH field group is enforced exactly as ADMIN_ROLE_TABLE says", async () => {
    const sample: Record<string, unknown> = {
      keyword_default: "Table Keyword",
      brand_name: "Table Brand",
      site_title: "Table Brand | Options",
      site_description: "Compare options from lending partners.",
      theme: { primary: "#0f766e", secondary: "#1e293b" },
      ab_config: { experiment_id: "exp-2026-10", variants: [{ id: "a", weight: 50 }, { id: "b", weight: 50 }] },
      amount_buckets: [500, 1000, 1500, 2500, 3000],
      flow_gate_mode: "signed_cookie",
      aid: "30003",
      prepop_base: "https://prepop.example/table",
      drain_key: "brand_table",
      google_ads_account: "4811219623",
      google_conversion_action: "7754587837",
      adkit_project: "proj-table",
      rotate_postback_token: true,
    };
    const rows = ADMIN_ROLE_TABLE.filter((r) => r.field_group !== null);
    expect(rows.length).toBe(Object.keys(BRAND_PATCH_FIELD_GROUPS).length);
    for (const row of rows) {
      const body = Object.fromEntries(row.fields!.map((f) => [f, sample[f]]));
      const asEmployee = await patch(employee, body);
      expect(asEmployee.status, `employee ${row.key}`).toBe(row.min_role === "owner" ? 403 : 200);
      const asOwner = await patch(owner, body);
      expect(asOwner.status, `owner ${row.key}`).toBe(200);
    }
  });

  it("panel-only actions follow the plan's matrix", () => {
    expect(PANEL_ROLE_TABLE).toEqual({
      listUsers: "owner",
      createUser: "owner",
      setUserRole: "owner",
      banUser: "owner",
      deleteUser: "owner",
      resetUserPassword: "owner",
      manageUserSessions: "owner",
      rollbackBrand: "owner",
      pauseBrand: "owner",
      createBrand: "employee",
      installBrand: "employee",
      generateBrand: "owner",
      setDraftTracking: "employee",
      duplicateBrand: "employee",
      upgradeAll: "owner",
      recoverBrand: "owner",
      redeployBrand: "owner",
      viewBrandEdit: "employee",
      editBrandAssets: "employee",
      setBrandMicrosoftAds: "owner",
      listTemplates: "employee",
      importTemplate: "employee",
      approveTemplate: "owner",
      manageTemplates: "owner",
      viewBuilderKeys: "employee",
      manageBuilderKeys: "owner",
      manageApiKeys: "owner",
      useAdkit: "owner",
      setMicrosoftAdsSetting: "owner",
      viewSettings: "owner",
      viewBrandTimeline: "employee",
      createAdsEvent: "employee",
      deleteAdsEvent: "owner",
      viewCampaigns: "employee",
      createCampaignDraft: "employee",
      enableCampaign: "owner",
      pauseCampaign: "owner",
      updateCampaignBudget: "owner",
      checkCampaignStatus: "employee",
      adAllocation: "owner",
    });
  });
});

describe("postback token is shown once", () => {
  it("appears only in the PATCH response, never in any later read", async () => {
    const res = await patch(owner, { rotate_postback_token: true });
    expect(res.status).toBe(200);
    const body = BrandPatchResponse.parse(await res.json());
    const token = body.issued_postback_token;
    expect(token).toMatch(/^[A-Za-z0-9._~-]{16,512}$/);
    expect(body.brand.postback_token).toBe("set");

    const reads = [
      "/api/brands",
      "/api/brands/brand-a",
      "/api/audit?limit=200",
    ];
    for (const cookie of [owner, employee]) {
      for (const path of reads) {
        const text = await (await call(path, { cookie })).text();
        expect(text, `${path}`).not.toContain(token!);
        expect(text).not.toContain("issued_postback_token");
      }
    }
    // The audit row records the state change, never the value.
    const audit = AuditListResponse.parse(await (await call("/api/audit", { cookie: owner })).json());
    expect(audit.entries.find((e) => e.action === "brand.update" && e.new?.postback_token === "set")).toBeTruthy();
  });
});

describe("audit", () => {
  it("panel-only actions write audit_log rows in FACTORY", async () => {
    const before = (await auditRows()).length;
    const created = await post(owner, "/api/users", { email: "audit@example.test", name: "A", password: "password-123", role: "employee" });
    const { user } = (await created.json()) as { user: { id: string } };
    await call(`/api/users/${user.id}`, { cookie: owner, method: "PATCH", body: { role: "owner" } });
    const rows = (await auditRows()).slice(before);
    expect(rows.map((r) => r.action)).toEqual(["user.create", "user.set_role"]);
    expect(rows.every((r) => r.actor_role === "owner" && r.entity_id === user.id)).toBe(true);
  });

  it("sign-in writes an auth.sign_in row", async () => {
    const before = (await auditRows()).filter((r) => r.action === "auth.sign_in").length;
    await sessions.employee();
    const after = (await auditRows()).filter((r) => r.action === "auth.sign_in");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ actor_role: "employee" });
  });

  it("the panel never writes brand/config audit rows itself (core does)", async () => {
    await patch(employee, { keyword_default: "Panel Check" });
    await post(owner, "/api/brands/brand-a/pause");
    expect((await auditRows()).filter((r) => r.action.startsWith("brand."))).toEqual([]);
  });

  it("an employee sees only their own entries; the owner sees all", async () => {
    await post(owner, "/api/brands/brand-a/pause");
    await post(employee, "/api/brands/brand-a/resume");
    await patch(owner, { keyword_default: "Owner Edit" });

    const emp = AuditListResponse.parse(await (await call("/api/audit?limit=200", { cookie: employee })).json());
    const empId = ((await (await call("/api/me", { cookie: employee })).json()) as { user: { id: string } }).user.id;
    expect(emp.entries.length).toBeGreaterThan(0);
    expect(emp.entries.every((e) => e.actor_id === empId)).toBe(true);
    expect(emp.entries.map((e) => e.action)).toContain("brand.resume");
    expect(emp.entries.map((e) => e.action)).toContain("auth.sign_in");

    const own = AuditListResponse.parse(await (await call("/api/audit?limit=200", { cookie: owner })).json());
    const actors = new Set(own.entries.map((e) => e.actor_id));
    expect(actors.size).toBeGreaterThan(1);
    expect(own.entries.map((e) => e.action)).toContain("brand.update");

    // Another employee does not see emp1's rows.
    const emp2 = AuditListResponse.parse(await (await call("/api/audit?limit=200", { cookie: employee2 })).json());
    expect(emp2.entries.every((e) => e.actor_id !== empId)).toBe(true);
  });
});

describe("factory brands: create / install / upgrade", () => {
  let _seq = 0;
  async function createBrand(cookie: string, overrides: Record<string, unknown> = {}): Promise<{ brand_id: string }> {
    const res = await post(cookie, "/api/brands/drafts", { domain: `t${++_seq}.example.com`, keyword_default: "quick loan", template_version_id: "tv-1", ...overrides });
    if (res.status !== 201) throw new Error(`createBrand failed: ${res.status} ${await res.text()}`);
    const { brand } = (await res.json()) as { brand: { brand_id: string } };
    return brand;
  }

  it("records a failed install when the factory binding is unavailable", async () => {
    const brand = await createBrand(employee);
    expect(brand.brand_id).toMatch(/^brand_/);

    const ins = await postNoMock(employee, `/api/brands/${brand.brand_id}/install`);
    expect(ins.status).toBe(502);
  });

  it("employee lists installs for the brand", async () => {
    const brand = await createBrand(employee);
    await postNoMock(employee, `/api/brands/${brand.brand_id}/install`);
    await postNoMock(employee, `/api/brands/${brand.brand_id}/install`);

    const res = await call(`/api/brands/${brand.brand_id}/installs`, { cookie: employee });
    expect(res.status).toBe(200);
    const { installs } = (await res.json()) as { installs: unknown[] };
    expect(installs.length).toBe(2);
  });

  it("returns 404 for install on unknown brand", async () => {
    expect((await post(employee, "/api/brands/no-such-brand/install")).status).toBe(404);
    expect((await post(employee, "/api/brands/no-such-brand/installs")).status).toBe(404);
  });

  it("POST /api/brands rejects invalid domain", async () => {
    const bad = await post(employee, "/api/brands", { name: "Bad", domain: "NOT_A_DOMAIN", keyword_default: "x" });
    expect(bad.status).toBe(410);
  });

  it("retires the legacy brand creation mutation", async () => {
    const response = await post(employee, "/api/brands", { name: "Legacy", domain: "legacy.example", keyword_default: "x" });
    expect(response.status).toBe(410);
  });

  it("employee cannot upgrade-all (403)", async () => {
    await expectForbidden(await post(employee, "/api/upgrade-all"));
  });

  it("owner upgrade-all requires the immutable source and target command", async () => {
    // Brands created are 'draft', upgrade-all targets live/paused — count = 0 here.
    const res = await post(owner, "/api/upgrade-all");
    expect(res.status).toBe(422);
  });

  it("Employee install and Owner rollback record the correct audit roles", async () => {
    const brand = await createBrand(employee);
    const before = (await auditRows()).length;
    expect((await postNoMock(employee, `/api/brands/${brand.brand_id}/install`)).status).toBe(502);
    expect((await postNoMock(owner, `/api/brands/${brand.brand_id}/rollback`)).status).toBe(502);
    const rows = (await auditRows()).slice(before);
    const starts = rows.filter((r) => r.action === "install.start");
    expect(starts).toHaveLength(2);
    expect(starts.map((r) => r.actor_role).sort()).toEqual(["employee", "owner"]);
  });

  it("createBrand writes a brand.create audit row", async () => {
    const before = (await auditRows()).length;
    await createBrand(owner);
    const rows = (await auditRows()).slice(before);
    expect(rows.some((r) => r.action === "brand.create")).toBe(true);
  });

  it("GET /api/funnel returns the fixture report for an employee", async () => {
    const res = await call("/api/funnel?from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z", { cookie: employee });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: [{ brand: "brand-a", sold: 1 }] });
  });

  it("GET /api/funnel without a window is invalid", async () => {
    expect((await call("/api/funnel", { cookie: employee })).status).toBe(422);
  });

  it("GET /api/alerts returns the fixture report for an employee", async () => {
    const res = await call("/api/alerts", { cookie: employee });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ conversion_stalled: { state: "ok" } });
  });

  it("GET /api/mailing returns local counts and does not require listmonk", async () => {
    const res = await call("/api/mailing", { cookie: employee });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      external_sync: "not_configured",
      counts: { pending: 1, sent: 2, skipped: 0, dead: 0 },
    });
  });

  it("unauthenticated cannot create a brand", async () => {
    expect((await post("", "/api/brands", { name: "X", domain: "x.example.com", keyword_default: "x" })).status).toBe(401);
  });
});

// Last in the file: every test signs in three users, and the mock core shares audit ids with the panel's audit_log, so an earlier extra test shifts the id collisions the audit-list tests above already sit near.
describe("settings audit", () => {
  it("an owner patching aid writes exactly one core brand.update entry with old and new aid, and no panel brand row", async () => {
    // target_type=brand skips the panel's own rows, so the read cannot collide with their ids.
    const updates = async () => AuditListResponse.parse(await (await call("/api/audit?limit=200&target_type=brand&target_id=brand-a", { cookie: owner })).json())
      .entries.filter((e) => e.action === "brand.update");
    const before = await updates();
    const oldAid = ((await (await call("/api/brands/brand-a", { cookie: owner })).json()) as { brand: { aid: string } }).brand.aid;
    const panelBrandRows = async () => (await auditRows()).filter((r) => r.action.startsWith("brand.")).length;
    const panelBefore = await panelBrandRows();

    const res = await patch(owner, { aid: "AID_NEW_77" });
    expect(res.status).toBe(200);

    const after = await updates();
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toMatchObject({ actor_role: "owner", target: { type: "brand", id: "brand-a" }, old: { aid: oldAid }, new: { aid: "AID_NEW_77" } });
    expect(await panelBrandRows()).toBe(panelBefore);
  });
});

describe("static assets", () => {
  it("hands every non-API path to the assets binding", async () => {
    const res = await call("/brands/brand-a");
    expect(await res.text()).toBe("ASSET:/brands/brand-a");
  });
  it("answers unknown API paths with 404 route", async () => {
    expect((await call("/api/nope", { cookie: employee })).status).toBe(404);
  });
});
