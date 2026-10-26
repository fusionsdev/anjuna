import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLE_TABLE,
  AdminApi,
  CONVERSION_SETUP_LEASE_MS,
  CONVERSION_SETUP_MAX_ATTEMPTS,
  ConversionName,
  ConversionSetupClaimRequest,
  ConversionSetupResultRequest,
  conversionSetupBackoffMs,
} from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const claim_id = "6f1d2c3e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

describe("conversion setup contract", () => {
  it("ConversionName accepts cv- plus 16 hex and rejects uppercase, brand text and wrong length", () => {
    expect(ConversionName.safeParse("cv-0123456789abcdef").success).toBe(true);
    for (const bad of [
      "cv-0123456789ABCDEF",
      "cv-brand-a-lead-form",
      "cv-0123456789abcde",
      "cv-0123456789abcdef0",
      "CV-0123456789abcdef",
      "0123456789abcdef",
      "cv-0123456789abcdeg",
      "cv-0123456789abcdef\n",
      "",
    ]) {
      expect(ConversionName.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("claim request rejects unknown fields", () => {
    const ok = { brand_id: "brand-a", name: "cv-0123456789abcdef" };
    expect(ConversionSetupClaimRequest.safeParse(ok).success).toBe(true);
    expect(ConversionSetupClaimRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(ConversionSetupClaimRequest.safeParse({ brand_id: "brand-a", name: "lead-form" }).success).toBe(false);
  });

  it("result request accepts exactly one of conversion_action_id or error", () => {
    const base = { brand_id: "brand-a", claim_id };
    expect(ConversionSetupResultRequest.safeParse({ ...base, conversion_action_id: "7123456789" }).success).toBe(true);
    expect(ConversionSetupResultRequest.safeParse({ ...base, error: "adkit exited 2" }).success).toBe(true);
    expect(ConversionSetupResultRequest.safeParse({ ...base, conversion_action_id: "7123456789", error: "x" }).success).toBe(false);
    expect(ConversionSetupResultRequest.safeParse(base).success).toBe(false);
    expect(ConversionSetupResultRequest.safeParse({ ...base, conversion_action_id: "abc" }).success).toBe(false);
    expect(ConversionSetupResultRequest.safeParse({ ...base, error: "" }).success).toBe(false);
    expect(ConversionSetupResultRequest.safeParse({ ...base, claim_id: "not-a-uuid", error: "x" }).success).toBe(false);
    expect(ConversionSetupResultRequest.safeParse({ ...base, error: "x", extra: 1 }).success).toBe(false);
  });

  it("result error longer than 500 characters is rejected", () => {
    const base = { brand_id: "brand-a", claim_id };
    expect(ConversionSetupResultRequest.safeParse({ ...base, error: "e".repeat(500) }).success).toBe(true);
    expect(ConversionSetupResultRequest.safeParse({ ...base, error: "e".repeat(501) }).success).toBe(false);
  });

  it("backoff doubles from 1 hour and caps at 24 hours", () => {
    expect(conversionSetupBackoffMs(1)).toBe(1 * HOUR);
    expect(conversionSetupBackoffMs(2)).toBe(2 * HOUR);
    expect(conversionSetupBackoffMs(5)).toBe(16 * HOUR);
    expect(conversionSetupBackoffMs(6)).toBe(24 * HOUR);
    expect(conversionSetupBackoffMs(40)).toBe(24 * HOUR);
    expect(CONVERSION_SETUP_LEASE_MS).toBe(30 * 60 * 1000);
    expect(CONVERSION_SETUP_MAX_ATTEMPTS).toBe(5);
  });

  it("conversionSetup endpoint is owner only", () => {
    expect(AdminApi.conversionSetup.min_role).toBe("owner");
    expect(AdminApi.conversionSetup.path).toBe("/admin/brands/:id/conversion-setup");
    const row = ADMIN_ROLE_TABLE.find((r) => r.endpoint === "conversionSetup" && r.field_group === null);
    expect(row?.min_role).toBe("owner");
    expect(row?.scope).toEqual({ employee: "none", owner: "all" });
  });
});
