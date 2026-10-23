import {
  AdminError,
  LeadExportResponse,
  LeadsResponse,
  SuppressionsResponse,
  ADMIN_CONTEXT_HEADERS,
  type AdminRole,
} from "@anjuna/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { mockCoreFetch, resetMockCore } from "../src/server/mock-core";
import { LEAD_ID } from "./helpers";

const ctxHeaders = (role: AdminRole): Record<string, string> => ({
  [ADMIN_CONTEXT_HEADERS.actor_id]: role === "owner" ? "usr_owner_01" : "usr_emp_01",
  [ADMIN_CONTEXT_HEADERS.actor_role]: role,
  [ADMIN_CONTEXT_HEADERS.request_id]: "req_01HZX9K2M4N6P8Q1",
});

const get = (path: string, role?: AdminRole): Promise<Response> =>
  mockCoreFetch(new Request(`https://core.test${path}`, { headers: role ? ctxHeaders(role) : {} }));

beforeEach(() => resetMockCore());

describe("mock core leads endpoints (FUS-376)", () => {
  it("serves the four leads endpoints with the contract check order", async () => {
    // 401 without a request context
    for (const path of ["/admin/leads", `/admin/leads/${LEAD_ID}`, "/admin/leads/export", "/admin/suppressions"]) {
      expect((await get(path)).status).toBe(401);
    }

    // 403: suppressions are owner only, and so is a PII export
    const suppressions = await get("/admin/suppressions", "employee");
    expect(suppressions.status).toBe(403);
    expect(AdminError.parse(await suppressions.json())).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    const piiExport = await get("/admin/leads/export?pii=1", "employee");
    expect(piiExport.status).toBe(403);
    expect(AdminError.parse(await piiExport.json())).toMatchObject({ error: "forbidden_role", denied_fields: ["pii"] });

    // 422 on a bad filter, before the role gate answers for the allowed endpoints
    expect((await get("/admin/leads?status=bogus", "employee")).status).toBe(422);
    expect((await get("/admin/leads?from=2026-10-02&to=2026-10-01", "owner")).status).toBe(422);
    expect((await get("/admin/leads/export?pii=2", "owner")).status).toBe(422);
    expect((await get("/admin/suppressions?source=bogus", "owner")).status).toBe(422);

    // two stages at once: the endpoint role gate (2) answers before validation (3), so a caller
    // who may not ask learns nothing about whether the value is valid
    const blocked = await get("/admin/suppressions?source=bogus", "employee");
    expect(blocked.status).toBe(403);
    expect(AdminError.parse(await blocked.json())).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    // validation (3) answers before the PII field group (4): a bad filter is 422 even with pii=1
    const badFilter = await get("/admin/leads/export?pii=1&status=bogus", "employee");
    expect(badFilter.status).toBe(422);
    expect(AdminError.parse(await badFilter.json())).toMatchObject({ error: "invalid" });

    // 200 otherwise; a non-PII export is allowed for an employee ("0" is not a PII request)
    expect(LeadsResponse.parse(await (await get("/admin/leads", "employee")).json()).rows).toHaveLength(2);
    const plain = await get("/admin/leads/export?pii=0", "employee");
    expect(plain.status).toBe(200);
    expect(LeadExportResponse.parse(await plain.json())).toMatchObject({ pii: false, truncated: false });
    expect((await get("/admin/leads/export", "employee")).status).toBe(200);
    const pii = LeadExportResponse.parse(await (await get("/admin/leads/export?pii=1", "owner")).json());
    expect(pii.pii).toBe(true);
    expect(pii.rows[0]).toHaveProperty("email");
    expect(SuppressionsResponse.parse(await (await get("/admin/suppressions", "owner")).json()).rows).toHaveLength(2);

    // 404 for a lead that is not in the fixtures
    expect((await get("/admin/leads/00000000-0000-4000-8000-000000000000", "owner")).status).toBe(404);
  });

  it("redacts the employee lead detail exactly as the fixtures do", async () => {
    const employee = await get(`/admin/leads/${LEAD_ID}`, "employee");
    expect(employee.status).toBe(200);
    const text = await employee.text();
    const body = JSON.parse(text);
    expect(body.lead.applicant).toBeNull();
    expect(body.lead.postbacks.map((p: { payout: unknown }) => p.payout)).toEqual([null, null]);
    expect(body.lead.conversion.value).toBeNull();
    expect(body.lead.profile.state).toBe("TX");
    expect(body.lead.conversion.last_error).toBeNull();
    for (const pii of ["first_name", "last_name", "birth_date", "email", "home_phone", "work_phone", "address", "city", "zip"]) {
      expect(text).not.toContain(`"${pii}"`);
    }

    const owner = await (await get(`/admin/leads/${LEAD_ID}`, "owner")).json() as typeof body;
    expect(owner.lead.applicant).not.toBeNull();
    expect(owner.lead.postbacks.every((p: { payout: unknown }) => typeof p.payout === "number")).toBe(true);

    // Values, not key names: nothing the owner sees and the employee must not may appear anywhere.
    // Applicant fields that the employee profile also carries (state, employer, ...) are not secret.
    const secrets: unknown[] = [
      ...Object.entries(owner.lead.applicant as Record<string, unknown>)
        .filter(([key, value]) => !(key in owner.lead.profile) && value !== null)
        .map(([, value]) => value),
      ...owner.lead.postbacks.map((p: { payout: unknown }) => p.payout),
      owner.lead.conversion.value,
      owner.lead.conversion.last_error,
    ];
    expect(secrets.length).toBeGreaterThanOrEqual(10);
    const leaves: unknown[] = [];
    const walk = (node: unknown): void => {
      if (node !== null && typeof node === "object") Object.values(node).forEach(walk);
      else leaves.push(node);
    };
    walk(body);
    for (const secret of secrets) {
      expect(leaves, `leaked ${JSON.stringify(secret)}`).not.toContain(secret);
      if (typeof secret === "string") expect(text).not.toContain(secret);
    }
  });

  it("filters its lead list by brand and status", async () => {
    const byStatus = LeadsResponse.parse(await (await get("/admin/leads?status=sold", "owner")).json());
    expect(byStatus.rows.map((r) => r.lead_id)).toEqual([LEAD_ID]);
    expect(byStatus.next_cursor).toBeNull();

    const byBrand = LeadsResponse.parse(await (await get("/admin/leads?brand=brand-b", "owner")).json());
    expect(byBrand.rows).toEqual([]);
    expect(LeadsResponse.parse(await (await get("/admin/leads?brand=brand-a", "owner")).json()).rows).toHaveLength(2);

    const exported = LeadExportResponse.parse(await (await get("/admin/leads/export?status=pending", "employee")).json());
    expect(exported.rows.map((r) => r.outcome)).toEqual(["pending"]);
  });
});
