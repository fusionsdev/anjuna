import { describe, expect, it } from "vitest";
import fixture from "../fixtures/admin/conversions.response.json";
import { AdminApi, CONVERSIONS_MAX_LIMIT, ConversionsQuery, ConversionsReportResponse, conversionReasonCode, employeeLastError } from "../src/index.js";

describe("conversionReasonCode", () => {
  it.each([
    ["no click id", "no_click_id"],
    ["no gclid/gbraid/wbraid", "no_click_id"],
    ["no msclkid", "no_click_id"],
    ["reclaim: exhausted attempts after stale lease", "lease_exhausted"],
    ["no route for brand=brand-a hostname=a.example", "no_route"],
    ["  No Route for brand=x", "no_route"],
    ["not ready yet: click too recent", "not_ready"],
    ["missing Microsoft env (ACCOUNT/CONVERSION_NAME)", "ms_env_missing"],
    ["upload failed", "upload_failed"],
    ["INVALID_GCLID: The gclid could not be decoded", "platform_error"],
  ] as const)("maps %j to %s", (text, code) => {
    expect(conversionReasonCode("dead", text)).toBe(code);
  });

  it("returns null for empty text, null text and uploaded rows", () => {
    expect(conversionReasonCode("pending", null)).toBeNull();
    expect(conversionReasonCode("pending", "   ")).toBeNull();
    expect(conversionReasonCode("uploaded", "upload failed")).toBeNull();
  });
});

describe("employeeLastError", () => {
  it.each([
    "no click id", "no gclid/gbraid/wbraid", "no msclkid", "reclaim: exhausted attempts after stale lease",
    "missing microsoft env (account/conversion_name)", "upload failed",
    "no route for brand=brand-b hostname=b.example", "no route for brand=null hostname=null",
  ])("keeps the fixed text %j", (text) => {
    expect(employeeLastError(text)).toBe(text);
  });

  it("matches the fixed texts without regard to case and returns them trimmed", () => {
    expect(employeeLastError("  Upload Failed \n")).toBe("Upload Failed");
    expect(employeeLastError("missing Microsoft env (ACCOUNT/CONVERSION_NAME)")).toBe("missing Microsoft env (ACCOUNT/CONVERSION_NAME)");
  });

  it.each([
    "upload failed: 500",
    'upload failed: {"value":85,"gclid":"GCLID-SECRET-123"}',
    "not ready yet: click too recent",
    "INVALID_GCLID: The gclid could not be decoded",
    'no route for brand=x hostname=y {"value":85}',
    'no route for brand=x hostname=y,"value":85',
    "",
  ])("returns null for %j", (text) => {
    expect(employeeLastError(text)).toBeNull();
  });

  it("returns null for null", () => {
    expect(employeeLastError(null)).toBeNull();
  });
});

describe("conversions schemas", () => {
  it("defaults status to all and rejects an unknown period", () => {
    expect(ConversionsQuery.parse({ period: "7d" })).toEqual({ period: "7d", status: "all" });
    expect(ConversionsQuery.safeParse({ period: "90d" }).success).toBe(false);
    expect(ConversionsQuery.safeParse({ period: "7d", extra: "1" }).success).toBe(false);
  });

  it("ConversionsQuery accepts limit 1 and 1000 and rejects 0 and 1001", () => {
    expect(ConversionsQuery.parse({ period: "7d", limit: "1" }).limit).toBe(1);
    expect(ConversionsQuery.parse({ period: "7d", limit: "1000" }).limit).toBe(CONVERSIONS_MAX_LIMIT);
    expect(ConversionsQuery.safeParse({ period: "7d", limit: "0" }).success).toBe(false);
    expect(ConversionsQuery.safeParse({ period: "7d", limit: "1001" }).success).toBe(false);
    expect(ConversionsQuery.safeParse({ period: "7d", limit: "1.5" }).success).toBe(false);
    expect(ConversionsQuery.parse({ period: "7d" }).limit).toBeUndefined();
  });

  it("parses the owner fixture and an employee shape with null money", () => {
    const owner = ConversionsReportResponse.parse(fixture);
    const employee = { ...owner, value_totals: null, rows: owner.rows.map((r) => ({ ...r, value: null })) };
    expect(ConversionsReportResponse.parse(employee).value_totals).toBeNull();
  });

  it("rejects a row that carries a click id value", () => {
    const row = { ...fixture.rows[0], gclid: "abc" };
    expect(ConversionsReportResponse.safeParse({ ...fixture, rows: [row] }).success).toBe(false);
  });

  it("registers the endpoint for employees", () => {
    expect(AdminApi.conversionsReport).toMatchObject({ method: "GET", path: "/admin/conversions", min_role: "employee" });
  });
});
