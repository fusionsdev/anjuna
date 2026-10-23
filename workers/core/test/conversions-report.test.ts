import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConversionsReportResponse, type AdminRequestContext } from "@anjuna/contracts";
import { createHarness, type Harness } from "./helpers.js";

const owner: AdminRequestContext = { actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_conv_owner" };
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_conv_emp" };
const now = "2026-10-23T12:00:00.000Z";

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
beforeEach(async () => {
  await h.reset();
  await h.seedBrand("brand-a", "token-a");
  await h.seedBrand("brand-b", "token-b");
});
afterAll(async () => { await h?.mf.dispose(); });

/** LeadId needs 8 to 64 characters, so short test names get a prefix. `short` strips it again. */
const lid = (name: string) => `lead-${name}`;
const short = (rows: Array<{ lead_id: string }>) => rows.map((r) => r.lead_id.replace(/^lead-/, ""));
/** One lead plus its conversion row. Every row gets a distinct click id unless the override sets one. */
async function seed(name: string, brand: string, overrides: Record<string, unknown> = {}) {
  await h.seedLead(lid(name), `cid-${name}`, brand);
  await h.seedConversion(lid(name), { gclid: `gclid-${name}`, created_at: "2026-10-20T08:00:00.000Z", updated_at: "2026-10-20T08:00:00.000Z", ...overrides });
}
const report = async (query = "", context = owner) => {
  const response = await h.admin(`/admin/conversions?period=7d&now=${now}${query}`, context);
  return { response, text: await response.text() };
};
const parsed = async (query = "", context = owner) => {
  const { response, text } = await report(query, context);
  expect(response.status).toBe(200);
  return ConversionsReportResponse.parse(JSON.parse(text));
};

/** The mixed set that cases 1, 2 and 7 share. Window for 7d at `now` is 2026-10-17 to 2026-10-24 (exclusive). */
async function seedMixed() {
  await seed("up-1", "brand-a", { status: "uploaded", value: 85 });
  await seed("up-2", "brand-a", { status: "uploaded", value: 40 });
  await seed("pend-new", "brand-a", { status: "pending", created_at: "2026-10-23T10:00:00.000Z", updated_at: null });
  await seed("pend-old", "brand-a", { status: "pending", created_at: "2026-10-22T00:00:00.000Z", updated_at: "2026-10-22T00:00:00.000Z" });
  await seed("proc-1", "brand-a", { status: "processing" });
  await seed("dead-1", "brand-b", {
    status: "dead", value: 30, last_error: "no route for brand=brand-b hostname=b.example", attempts: 3,
  });
  await seed("dead-2", "brand-b", { status: "dead", value: 30, last_error: "no click id", gclid: null });
  await seed("up-old", "brand-a", { status: "uploaded", value: 500, created_at: "2026-10-10T08:00:00.000Z", updated_at: "2026-10-10T08:00:00.000Z" });
}

describe("GET /admin/conversions", () => {
  it("counts the period window by status and ignores rows before it", async () => {
    await seedMixed();
    const body = await parsed();
    expect(body.period).toBe("7d");
    expect(body.from).toBe("2026-10-17T00:00:00.000Z");
    expect(body.to).toBe("2026-10-24T00:00:00.000Z");
    expect(body.totals).toEqual({ pending: 2, processing: 1, uploaded: 2, dead: 2 });
    expect(body.value_totals).toEqual({ uploaded: 125, dead: 60 });
    expect(body.rows).toHaveLength(7);
    expect(short(body.rows)).not.toContain("up-old");
    expect(body.truncated).toBe(false);
  });

  it("counts stalled pending rows older than 6 hours at any age", async () => {
    await seedMixed();
    // pend-old (2026-10-22) is stalled and in the window. pend-new (10:00Z, 2h old) is not.
    expect((await parsed()).stalled).toBe(1);
    // A pending row from 2026-10-01 is outside the 7d window but still stalled.
    await seed("pend-ancient", "brand-a", { status: "pending", created_at: "2026-10-01T00:00:00.000Z", updated_at: null });
    const body = await parsed();
    expect(body.stalled).toBe(2);
    expect(body.totals.pending).toBe(2);
    expect(short(body.rows)).not.toContain("pend-ancient");
  });

  it("orders dead, pending, processing, uploaded, newest updated_at first", async () => {
    await seed("up-new", "brand-a", { status: "uploaded", updated_at: "2026-10-22T09:00:00.000Z" });
    await seed("up-old", "brand-a", { status: "uploaded", updated_at: "2026-10-21T09:00:00.000Z" });
    await seed("proc-1", "brand-a", { status: "processing", updated_at: "2026-10-22T09:00:00.000Z" });
    await seed("pend-old", "brand-a", { status: "pending", updated_at: "2026-10-21T09:00:00.000Z", last_error: "not ready yet" });
    await seed("pend-new", "brand-a", { status: "pending", updated_at: "2026-10-22T09:00:00.000Z" });
    await seed("dead-old", "brand-a", { status: "dead", updated_at: "2026-10-21T09:00:00.000Z", last_error: "no click id" });
    await seed("dead-new", "brand-a", { status: "dead", updated_at: "2026-10-22T09:00:00.000Z", last_error: "no click id" });
    // A fresh pending row has updated_at NULL in D1 (postback.ts). It sorts by created_at and reports it.
    await seed("pend-null", "brand-a", { status: "pending", created_at: "2026-10-22T18:00:00.000Z", updated_at: null });
    const body = await parsed();
    expect(short(body.rows)).toEqual([
      "dead-new", "dead-old", "pend-null", "pend-new", "pend-old", "proc-1", "up-new", "up-old",
    ]);
    const nullRow = body.rows.find((r) => r.lead_id === lid("pend-null"))!;
    expect(nullRow.updated_at).toBe("2026-10-22T18:00:00.000Z");
  });

  it("maps reason codes and click types without leaking click ids", async () => {
    await seed("with-gclid", "brand-a", { status: "dead", gclid: "SECRET-GCLID-111", last_error: "  No Route for brand=brand-a hostname=a.example" });
    await seed("with-msclkid", "brand-a", { status: "dead", gclid: null, msclkid: "SECRET-MSCLKID-222", last_error: "upload failed: 500" });
    await seed("with-nothing", "brand-a", { status: "dead", gclid: null, last_error: "no click id" });
    await seed("done", "brand-a", { status: "uploaded", gclid: "SECRET-GCLID-333", last_error: "stale text" });
    const { response, text } = await report();
    expect(response.status).toBe(200);
    const body = ConversionsReportResponse.parse(JSON.parse(text));
    const byId = Object.fromEntries(body.rows.map((r) => [r.lead_id.replace(/^lead-/, ""), r]));
    expect(byId["with-gclid"]).toMatchObject({ click_type: "gclid", reason_code: "no_route" });
    expect(byId["with-msclkid"]).toMatchObject({ click_type: "msclkid", reason_code: "upload_failed" });
    expect(byId["with-nothing"]).toMatchObject({ click_type: null, reason_code: "no_click_id" });
    expect(byId["done"]).toMatchObject({ click_type: "gclid", reason_code: null });
    for (const secret of ["SECRET-GCLID-111", "SECRET-MSCLKID-222", "SECRET-GCLID-333"]) {
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/"(gclid|gbraid|wbraid|msclkid)"\s*:/);
  });

  it("filters rows by status and brand but keeps totals for the whole window", async () => {
    await seedMixed();
    const full = await parsed();
    const dead = await parsed("&status=dead");
    expect(short(dead.rows).sort()).toEqual(["dead-1", "dead-2"]);
    expect(dead.totals).toEqual(full.totals);
    expect(dead.value_totals).toEqual(full.value_totals);
    expect(dead.stalled).toBe(full.stalled);

    const brandA = await parsed("&brand=brand-a");
    expect(brandA.rows.every((r) => r.brand === "brand-a")).toBe(true);
    expect(brandA.rows).toHaveLength(5);
    expect(brandA.totals).toEqual(full.totals);

    const both = await parsed("&status=pending&brand=brand-a");
    expect(short(both.rows).sort()).toEqual(["pend-new", "pend-old"]);
    const none = await parsed("&status=dead&brand=brand-a");
    expect(none.rows).toEqual([]);
    expect(none.totals).toEqual(full.totals);
    expect(none.truncated).toBe(false);
  });

  it("truncates at 200 rows", async () => {
    // 201 rows through one recursive insert each. 402 seedLead/seedConversion calls take about 30 seconds.
    await h.db.batch([
      h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
        INSERT INTO leads (
          lead_id, session_id, form_version, form_variant, site_id, brand, hostname,
          requested_amount, loan_purpose, first_name, last_name, birth_date, email, home_phone,
          address, city, state, zip, address_length_months, own_home, income_type, employer,
          job_title, employed_months, pay_date1, pay_frequency, direct_deposit, monthly_income,
          tracking_json, metadata_json, created_at, click_id
        ) SELECT 'lead-bulk-' || i, 'session', 'test', 'lite_v1', 'form-default', 'brand-a', 'brand-a.example',
          1000, 'OTHER', 'Test', 'Applicant', '1990-01-01', 'test@example.com', '2145550123',
          '100 Example St', 'Dallas', 'TX', '75201', 24, 0, 'EMPLOYMENT', 'Example',
          'Clerk', 24, '2026-10-09', 'BIWEEKLY', 1, 3000, '{}', '{}', '2026-01-01T00:00:00.000Z', 'cid-bulk-' || i
        FROM n`),
      h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
        INSERT INTO conversion_uploads (lead_id, gclid, value, currency, occurred_at, status, created_at, updated_at)
        SELECT 'lead-bulk-' || i, 'gclid-bulk-' || i, 10, 'USD', '2026-10-20T08:00:00.000Z', 'uploaded',
          '2026-10-20T08:00:00.000Z', '2026-10-20T08:00:00.000Z'
        FROM n`),
    ]);
    const body = await parsed();
    expect(body.rows).toHaveLength(200);
    expect(body.truncated).toBe(true);
    expect(body.totals.uploaded).toBe(201);
    expect(body.value_totals?.uploaded).toBe(2010);

    const filtered = await parsed("&status=pending");
    expect(filtered.rows).toEqual([]);
    expect(filtered.truncated).toBe(false);
  });

  it("redacts money for an employee", async () => {
    await seedMixed();
    // A payload echo with the value 85 inside: the owner sees it, an employee gets null.
    await seed("echo-85", "brand-a", { status: "pending", last_error: 'Command failed: {"value":85}' });
    const asOwner = await parsed("", owner);
    const asEmployee = await parsed("", employee);
    expect(asOwner.value_totals).toEqual({ uploaded: 125, dead: 60 });
    expect(asOwner.rows.some((r) => typeof r.value === "number" && r.value > 0)).toBe(true);
    expect(asEmployee.value_totals).toBeNull();
    expect(asEmployee.rows).toHaveLength(asOwner.rows.length);
    expect(asEmployee.rows.every((r) => r.value === null)).toBe(true);
    expect(asEmployee.totals).toEqual(asOwner.totals);
    expect(asEmployee.stalled).toBe(asOwner.stalled);
    expect(short(asEmployee.rows)).toEqual(short(asOwner.rows));
    expect(asOwner.rows.some((r) => r.last_error?.includes("85"))).toBe(true);
    expect(asEmployee.rows.some((r) => r.last_error?.includes("85"))).toBe(false);
    // The raw body carries no dollar amount at all: 85, 40 and 30 are the seeded values.
    const { text } = await report("", employee);
    expect(text).not.toMatch(/"value"\s*:\s*[0-9]/);
    expect(text).not.toMatch(/"value_totals"\s*:\s*\{/);
  });

  it("cuts the click id for the owner and gives an employee null for a payload echo", async () => {
    const echoed = 'Command failed: adkit manage google conversions upload --data {"conversions":[{"value":85,"gclid":"GCLID-SECRET-123"}]}';
    await seed("echo-dead", "brand-a", { status: "dead", gclid: "GCLID-SECRET-123", value: 85, last_error: echoed });
    const asOwner = await report("", owner);
    const ownerRow = ConversionsReportResponse.parse(JSON.parse(asOwner.text)).rows[0]!;
    expect(ownerRow.reason_code).toBe("platform_error");
    expect(ownerRow.last_error).toBe('Command failed: adkit manage google conversions upload --data {"conversions":[{"value":85 [click id hidden]');
    expect(asOwner.text).not.toContain("GCLID-SECRET-123");

    const asEmployee = await report("", employee);
    const employeeRow = ConversionsReportResponse.parse(JSON.parse(asEmployee.text)).rows[0]!;
    expect(employeeRow).toMatchObject({ reason_code: "platform_error", last_error: null, value: null });
    expect(asEmployee.text).not.toContain("GCLID-SECRET-123");
    // JSON.stringify escapes the quotes of a string field, so check both spellings.
    expect(asEmployee.text).not.toContain('"value":85');
    expect(asEmployee.text).not.toContain('\\"value\\":85');
  });

  it("gives an employee null for a prefix-matched code that carries money", async () => {
    await seed("upload-money", "brand-a", { status: "dead", gclid: "GCLID-SECRET-123", last_error: 'upload failed: {"value":85,"gclid":"GCLID-SECRET-123"}' });
    const asOwner = await report("", owner);
    const ownerRow = ConversionsReportResponse.parse(JSON.parse(asOwner.text)).rows[0]!;
    expect(ownerRow.reason_code).toBe("upload_failed");
    expect(ownerRow.last_error).toBe('upload failed: {"value":85 [click id hidden]');
    expect(asOwner.text).not.toContain("GCLID-SECRET-123");

    const asEmployee = await report("", employee);
    const employeeRow = ConversionsReportResponse.parse(JSON.parse(asEmployee.text)).rows[0]!;
    expect(employeeRow).toMatchObject({ reason_code: "upload_failed", last_error: null });
    expect(asEmployee.text).not.toContain("GCLID-SECRET-123");
    expect(asEmployee.text).not.toContain('"value":85');
    expect(asEmployee.text).not.toContain('\\"value\\":85');
  });

  /**
   * Owner `last_error` is cut at the first click id key (ruling 2026-10-24). Each case seeds one dead row,
   * then the raw response body must be free of every secret. The expected text is the part before the key.
   */
  describe("owner last_error cut rule", () => {
    const SECRET = "X-SECRET";
    const cut = "upload failed [click id hidden]";
    /** JSON.stringify `times` times, the way an echo passes through nested logging. */
    const wrap = (text: string, times: number) => {
      let out = text;
      for (let i = 0; i < times; i++) out = JSON.stringify(out).slice(1, -1);
      return out;
    };
    /** Seeds one dead row per case. `rowIds` sets the row's own click id column for a case. */
    async function ownerView(cases: Record<string, string>, rowIds: Record<string, string> = {}) {
      for (const [name, last_error] of Object.entries(cases)) {
        await seed(name, "brand-a", { status: "dead", last_error, ...(rowIds[name] === undefined ? {} : { gclid: rowIds[name] }) });
      }
      const { response, text } = await report("", owner);
      expect(response.status).toBe(200);
      const body = ConversionsReportResponse.parse(JSON.parse(text));
      const errors: Record<string, string | null> = Object.fromEntries(body.rows.map((r) => [r.lead_id.replace(/^lead-/, ""), r.last_error]));
      return { text, errors };
    }

    it("cuts a plain JSON pair and a key that comes first", async () => {
      const { text, errors } = await ownerView({
        plain: 'upload failed: {"gclid":"X"}',
        first: "gclid=X-SECRET, then more text",
        keyed: 'Command failed: {"value":85,"gbraid":"X-SECRET","wbraid":"X-SECRET-2"}',
      });
      // The trailing punctuation set includes the colon, so the colon before the key goes with it.
      expect(errors["plain"]).toBe(cut);
      expect(errors["first"]).toBe("[click id hidden]");
      expect(errors["keyed"]).toBe('Command failed: {"value":85 [click id hidden]');
      expect(text).not.toContain(SECRET);
    });

    it("hides a value written after a space, a bracket prefix, a hex escape or a newline", async () => {
      const { text, errors } = await ownerView({
        space: "upload failed: gclid= X-SECRET",
        bracket: 'upload failed: {"gclid":"[x]X-SECRET"}',
        hex: String.raw`upload failed: {"gclid":"AB\x41X-SECRET"}`,
        newline: String.raw`upload failed: {"gclid":"AB\nX-SECRET"}`,
      });
      for (const name of ["space", "bracket", "hex", "newline"]) expect(errors[name], name).toBe(cut);
      expect(text).not.toContain(SECRET);
    });

    it("hides a value behind a nested object, an arrow, a key suffix or a percent-encoded key", async () => {
      const { text, errors } = await ownerView({
        nested: 'upload failed: {"gclid":{"id":"X-SECRET"}}',
        arrow: 'upload failed: gclid => "X-SECRET"',
        list: "upload failed: gclid_list=[X-SECRET]",
        percent: "upload failed: %67clid=X-SECRET",
        cli: "upload failed: --msclkid X-SECRET --json",
        single: "upload failed: {'gclid': 'X-SECRET', 'value': 85}",
        slash: String.raw`upload failed: {"gclid":"SLASH-ONE\/X-SECRET"}`,
      });
      for (const name of ["nested", "arrow", "list", "percent", "cli", "single", "slash"]) expect(errors[name], name).toBe(cut);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("SLASH-ONE");
    });

    it("decodes up to 7 escape layers and gives null when the text is still changing in round 8", async () => {
      const payload = 'upload failed: {"gclid":"X-SECRET"}';
      const { text, errors } = await ownerView({
        layers5: wrap(payload, 5),
        layers7: wrap(payload, 7),
        layers9: wrap(payload, 9),
      });
      expect(errors["layers5"]).toBe(cut);
      expect(errors["layers7"]).toBe(cut);
      expect(errors["layers9"]).toBeNull();
      expect(text).not.toContain(SECRET);
    });

    it("decodes an uppercase unicode backslash chain that spells the key", async () => {
      // \u005C is a backslash. Round 1 gives \u005Cu0067clid, round 2 gives \u0067clid, round 3 gives gclid.
      const { text, errors } = await ownerView({ upper: String.raw`upload failed: {"\u005Cu005Cu0067clid":"X-SECRET"}` });
      expect(errors["upper"]).toBe(cut);
      expect(text).not.toContain(SECRET);
    });

    it("cuts a click id behind double-escaped quotes and a double-escaped unicode escape", async () => {
      // Raw text: {\"gclid\":\"\\u0043LICK-SECRET-1\"}. Round 1 gives {"gclid":"\u0043LICK-SECRET-1"}, round 2 gives CLICK-SECRET-1.
      await seed("double", "brand-a", { status: "dead", gclid: "CLICK-SECRET-1", last_error: String.raw`upload failed: {\"gclid\":\"\\u0043LICK-SECRET-1\"}` });
      const { text } = await report("", owner);
      const row = ConversionsReportResponse.parse(JSON.parse(text)).rows[0]!;
      expect(row.last_error).toBe(cut);
      expect(text).not.toContain("CLICK-SECRET-1");
      expect(text).not.toContain("LICK-SECRET-1");
    });

    it("gives null when the kept text holds a row id with a space, a comma or a backslash", async () => {
      const { text, errors } = await ownerView(
        {
          "row-space": "upload failed for AB ROWSP-SECRET",
          "row-comma": "upload failed for AB,COMMA-SECRET-2",
          "row-slash": String.raw`upload failed for AB\BSLASH-SECRET-3`,
          "row-slash-json": String.raw`upload failed for AB\\BSLASH-SECRET-3`,
        },
        { "row-space": "AB ROWSP-SECRET", "row-comma": "AB,COMMA-SECRET-2", "row-slash": String.raw`AB\BSLASH-SECRET-3`, "row-slash-json": String.raw`AB\BSLASH-SECRET-3` },
      );
      for (const name of ["row-space", "row-comma", "row-slash", "row-slash-json"]) expect(errors[name], name).toBeNull();
      for (const secret of ["AB ROWSP", "ROWSP-SECRET", "COMMA-SECRET-2", "BSLASH-SECRET-3"]) expect(text).not.toContain(secret);
    });

    it("cuts before a row id that follows a key, even with a space, a comma or a backslash in it", async () => {
      const { text, errors } = await ownerView(
        {
          "key-space": "upload failed: gclid=AB ROWSP-SECRET, retry",
          "key-comma": 'upload failed: {"gclid":"AB,COMMA-SECRET-2"}',
          "key-slash": String.raw`upload failed: {"gclid":"AB\\BSLASH-SECRET-3"}`,
        },
        { "key-space": "AB ROWSP-SECRET", "key-comma": "AB,COMMA-SECRET-2", "key-slash": String.raw`AB\BSLASH-SECRET-3` },
      );
      for (const name of ["key-space", "key-comma", "key-slash"]) expect(errors[name], name).toBe(cut);
      for (const secret of ["ROWSP-SECRET", "COMMA-SECRET-2", "BSLASH-SECRET-3"]) expect(text).not.toContain(secret);
    });

    it("gives null for a row id the drain cut at 300 characters with no key in front", async () => {
      // "upload failed for " (18) + 270 filler + the first 12 characters of the id = 300.
      const echoed = `upload failed for ${"z".repeat(270)}TRUNC-ROW-SE`;
      expect(echoed).toHaveLength(300);
      const { text, errors } = await ownerView({ trunc: echoed }, { trunc: "TRUNC-ROW-SECRET-1" });
      expect(errors["trunc"]).toBeNull();
      expect(text).not.toContain("TRUNC-ROW-SE");
    });

    it("matches a row id shorter than 8 characters whole", async () => {
      const { errors } = await ownerView(
        { whole: "upload failed for ab12 today", partial: "upload failed for ab1 today" },
        { whole: "ab12", partial: "ab12" },
      );
      expect(errors["whole"]).toBeNull();
      expect(errors["partial"]).toBe("upload failed for ab1 today");
    });

    it("shows decoded text that holds no click id key and no row id", async () => {
      const { errors } = await ownerView({ "plain-text": String.raw`upload failed:\n\"timeout\" at 10%25`, money: 'Command failed: {"value":85}' });
      expect(errors["plain-text"]).toBe('upload failed: "timeout" at 10%');
      expect(errors["money"]).toBe('Command failed: {"value":85}');
    });
  });

  it("keeps the exact template texts for an employee and nulls anything else", async () => {
    const templates = [
      "no click id", "no gclid/gbraid/wbraid", "no msclkid", "reclaim: exhausted attempts after stale lease",
      "no route for brand=brand-b hostname=b.example", "missing Microsoft env (ACCOUNT/CONVERSION_NAME)", "upload failed",
    ];
    for (const [i, template] of templates.entries()) await seed(`template-${i}`, "brand-a", { status: "dead", last_error: template });
    await seed("padded", "brand-a", { status: "dead", last_error: "  Upload Failed \n" });
    await seed("route-money", "brand-a", { status: "dead", last_error: 'no route for brand=x hostname=y {"value":85}' });
    await seed("route-glued", "brand-a", { status: "dead", last_error: 'no route for brand=x hostname=y,"value":85' });
    await seed("route-null", "brand-a", { status: "dead", last_error: "no route for brand=null hostname=null" });
    await seed("not-ready", "brand-a", { status: "pending", last_error: "not ready yet: conversion action still propagating" });
    const byId = async (context: AdminRequestContext) =>
      Object.fromEntries((await parsed("", context)).rows.map((r) => [r.lead_id.replace(/^lead-/, ""), r]));
    const asEmployee = await byId(employee);
    for (const [i, template] of templates.entries()) expect(asEmployee[`template-${i}`]!.last_error, template).toBe(template);
    expect(asEmployee["padded"]).toMatchObject({ reason_code: "upload_failed", last_error: "Upload Failed" });
    expect(asEmployee["route-money"]).toMatchObject({ reason_code: "no_route", last_error: null });
    expect(asEmployee["route-glued"]).toMatchObject({ reason_code: "no_route", last_error: null });
    expect(asEmployee["route-null"]).toMatchObject({ reason_code: "no_route", last_error: "no route for brand=null hostname=null" });
    expect(asEmployee["not-ready"]).toMatchObject({ reason_code: "not_ready", last_error: null });
    const asOwner = await byId(owner);
    expect(asOwner["route-money"]!.last_error).toBe('no route for brand=x hostname=y {"value":85}');
    expect(asOwner["not-ready"]!.last_error).toBe("not ready yet: conversion action still propagating");
  });

  it("rejects an unknown period with 422", async () => {
    for (const query of ["period=90d", "period=", "status=lost&period=7d", "period=7d&brand=Bad%20Brand"]) {
      const response = await h.admin(`/admin/conversions?${query}&now=${now}`, owner);
      expect(response.status, query).toBe(422);
      expect(await response.json()).toMatchObject({ error: "invalid", request_id: owner.request_id });
    }
    const missing = await h.admin(`/admin/conversions?now=${now}`, employee);
    expect(missing.status).toBe(422);
  });
});
