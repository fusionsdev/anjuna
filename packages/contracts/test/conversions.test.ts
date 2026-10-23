import { describe, expect, it } from "vitest";
import fixture from "../fixtures/admin/conversions.response.json";
import { AdminApi, ConversionsQuery, ConversionsReportResponse, conversionReasonCode } from "../src/index.js";

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

describe("conversions schemas", () => {
  it("defaults status to all and rejects an unknown period", () => {
    expect(ConversionsQuery.parse({ period: "7d" })).toEqual({ period: "7d", status: "all" });
    expect(ConversionsQuery.safeParse({ period: "90d" }).success).toBe(false);
    expect(ConversionsQuery.safeParse({ period: "7d", extra: "1" }).success).toBe(false);
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
