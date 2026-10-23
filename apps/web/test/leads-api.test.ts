import {
  AdminError,
  GetLeadResponse,
  LEAD_EXPORT_COLUMNS,
  LEAD_EXPORT_PII_COLUMNS,
  LeadsResponse,
} from "@anjuna/contracts";
import leadsExportPii from "@anjuna/contracts/fixtures/admin/leads.export.response.pii.json";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LEAD_ID, call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;

beforeAll(async () => {
  await setupDatabases();
});
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
});

/** A stand-in CORE binding: records each request and answers with `reply`. */
function fakeCore(reply: (url: URL) => unknown) {
  const seen: URL[] = [];
  const fetcher = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      seen.push(url);
      return Response.json(reply(url));
    },
  } as unknown as Fetcher;
  return { seen, env: makeEnv({ MOCK_CORE: "0", CORE: fetcher }) };
}

describe("leads routes (FUS-376)", () => {
  it("does not capture /api/leads/aggregates or /api/leads/export with the lead id route", async () => {
    expect((await call("/api/leads/aggregates?from=2026-09-26&to=2026-10-02", { cookie: employee })).status).toBe(200);
    const exported = await call("/api/leads/export", { cookie: employee });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });

  it("answers 200 with applicant null to an employee on lead detail", async () => {
    const res = await call(`/api/leads/${LEAD_ID}`, { cookie: employee });
    expect(res.status).toBe(200);
    const body = GetLeadResponse.parse(await res.json());
    expect(body.lead.applicant).toBeNull();
    expect(body.lead.profile.state).toBe("TX");
  });

  it("returns CSV with the declared columns, CRLF rows and the formula guard", async () => {
    const plain = await call("/api/leads/export?from=2026-10-01&to=2026-10-02", { cookie: employee });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-disposition")).toBe('attachment; filename="leads-2026-10-01_2026-10-02.csv"');
    expect(plain.headers.get("cache-control")).toBe("no-store");
    const text = await plain.text();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(LEAD_EXPORT_COLUMNS.join(","));
    expect(lines).toHaveLength(4); // header, 2 rows, trailing empty after the last CRLF
    expect(lines[3]).toBe("");
    expect(text).not.toContain("null");
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    // keyword and variant are null on the second fixture row: empty cells, not text
    expect(lines[2]!.split(",")[8]).toBe("");

    // The fixtures hold no formula-like value, so core is stood in for with one in every free-text cell.
    const row = (extra: Record<string, unknown>) => ({
      ...leadsExportPii.rows[0]!,
      lead_id: LEAD_ID,
      ...extra,
    });
    const { env } = fakeCore(() => ({
      rows: [
        row({ first_name: "=HYPERLINK(\"http://x\")", last_name: "+1", city: "-2", employer: "@SUM(A1)", address: 'a "b", c' }),
      ],
      truncated: false,
      pii: true,
    }));
    const guarded = await call("/api/leads/export?pii=1&from=2026-10-01&to=2026-10-02", { cookie: owner, env });
    expect(guarded.status).toBe(200);
    const g = (await guarded.text()).split("\r\n");
    expect(g[0]).toBe(LEAD_EXPORT_PII_COLUMNS.join(","));
    expect(g[1]).toContain(`,"'=HYPERLINK(""http://x"")",`);
    expect(g[1]).toContain(",'+1,");
    expect(g[1]).toContain(",'-2,");
    expect(g[1]).toContain(",'@SUM(A1),");
    expect(g[1]).toContain(',"a ""b"", c",');
    // work_phone is null in the row: an empty cell between home_phone and address
    expect(g[1]).toContain(",2145550123,,");
  });

  it("is 403 for an employee on pii=1 and sets x-export-truncated for an owner", async () => {
    const denied = await call("/api/leads/export?pii=1", { cookie: employee });
    expect(denied.status).toBe(403);
    expect(AdminError.parse(await denied.json())).toMatchObject({
      error: "forbidden_role",
      required_role: "owner",
      denied_fields: ["pii"],
    });

    const allowed = await call("/api/leads/export?pii=1&from=2026-10-01&to=2026-10-02", { cookie: owner });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("x-export-truncated")).toBe("true");
    expect(allowed.headers.get("content-disposition")).toMatch(/-pii\.csv"$/);
    expect(allowed.headers.get("content-disposition")).toBe('attachment; filename="leads-2026-10-01_2026-10-02-pii.csv"');
    expect((await allowed.text()).split("\r\n")[0]).toBe(LEAD_EXPORT_PII_COLUMNS.join(","));

    const plain = await call("/api/leads/export?pii=0", { cookie: employee });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-export-truncated")).toBe("false");
    expect(plain.headers.get("content-disposition")).toBe('attachment; filename="leads-export.csv"');
    const text = await plain.text();
    const ownerRow = leadsExportPii.rows[0]!;
    for (const key of ["first_name", "last_name", "birth_date", "email", "home_phone", "address", "city", "zip"] as const) {
      expect(text, key).not.toContain(String(ownerRow[key]));
    }

    // validation (stage 3) answers before the PII field group (stage 4)
    expect((await call("/api/leads/export?pii=1&status=bogus", { cookie: employee })).status).toBe(422);
  });

  it("passes the filters through and answers 422 on a bad one", async () => {
    const { seen, env } = fakeCore(() => ({ rows: [], next_cursor: null }));
    const res = await call(
      "/api/leads?brand=brand-a&from=2026-09-01&to=2026-09-30&status=sold&q=6f1c2b9e&limit=10&cursor=abc",
      { cookie: employee, env },
    );
    expect(res.status).toBe(200);
    LeadsResponse.parse(await res.json());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pathname).toBe("/admin/leads");
    expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({
      brand: "brand-a",
      from: "2026-09-01",
      to: "2026-09-30",
      status: "sold",
      q: "6f1c2b9e",
      limit: "10",
      cursor: "abc",
    });

    const bad = await call("/api/leads?from=2026-10-02&to=2026-10-01", { cookie: employee, env });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: "invalid", issues: expect.any(Array) });
    expect((await call("/api/leads?q=ab", { cookie: employee, env })).status).toBe(422);
    expect(seen).toHaveLength(1); // a rejected query never reaches core

    // the export keeps from and to in the file name and the filters on the wire
    const exp = fakeCore(() => ({ rows: [], truncated: false, pii: false }));
    const exported = await call("/api/leads/export?brand=brand-a&status=pending&from=2026-09-01&to=2026-09-30", {
      cookie: employee,
      env: exp.env,
    });
    expect(exported.headers.get("content-disposition")).toBe('attachment; filename="leads-2026-09-01_2026-09-30.csv"');
    expect(exp.seen[0]!.searchParams.get("status")).toBe("pending");
    expect((await call("/api/leads/export?from=2026-10-02&to=2026-10-01", { cookie: employee })).status).toBe(422);
  });

  it("answers 401 without a session on every leads route", async () => {
    for (const path of ["/api/leads", "/api/leads/export", `/api/leads/${LEAD_ID}`]) {
      expect((await call(path)).status, path).toBe(401);
    }
  });
});
