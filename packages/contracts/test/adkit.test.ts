import { describe, expect, it } from "vitest";
import {
  ADKIT_DIRECTORY_STALE_MS,
  ADKIT_JOB_LEASE_MS,
  ADKIT_JOB_MAX_ATTEMPTS,
  AdkitDirectoryIngestRequest,
  AdkitJobCreateRequest,
  AdkitJobResultRequest,
  adkitJobBackoffMs,
} from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const JOB = "11111111-1111-4111-8111-111111111111";
const CLAIM = "22222222-2222-4222-8222-222222222222";

describe("AdKit contracts", () => {
  it("fixes the lease, attempts, staleness and backoff", () => {
    expect(ADKIT_JOB_LEASE_MS).toBe(30 * 60 * 1000);
    expect(ADKIT_JOB_MAX_ATTEMPTS).toBe(5);
    expect(ADKIT_DIRECTORY_STALE_MS).toBe(2 * HOUR);
    expect([1, 2, 5, 6, 40].map(adkitJobBackoffMs)).toEqual([HOUR, 2 * HOUR, 16 * HOUR, 24 * HOUR, 24 * HOUR]);
  });

  it("checks directory id formats per kind", () => {
    const ok = AdkitDirectoryIngestRequest.safeParse({ items: [
      { kind: "project", id: "proj_a", parent_id: null, name: "Project A", currency: null },
      { kind: "account", id: "4811219623", parent_id: "proj_a", name: "Account", currency: "THB" },
      { kind: "conversion_action", id: "7300000001", parent_id: "4811219623", name: "cv-0123456789abcdef", currency: null },
    ] });
    expect(ok.success).toBe(true);
    for (const bad of [
      { kind: "account", id: "481-121-9623", parent_id: null, name: "A", currency: null },
      { kind: "account", id: "4811219623", parent_id: null, name: "A", currency: "baht" },
      { kind: "conversion_action", id: "73", parent_id: null, name: "A", currency: null },
      { kind: "campaign", id: "1", parent_id: null, name: "A", currency: null },
    ]) expect(AdkitDirectoryIngestRequest.safeParse({ items: [bad] }).success, JSON.stringify(bad)).toBe(false);
    expect(AdkitDirectoryIngestRequest.safeParse({ items: [] }).success).toBe(false);
  });

  it("accepts only the conversion_action.create job kind", () => {
    expect(AdkitJobCreateRequest.safeParse({ kind: "conversion_action.create", brand_draft_id: "brand-a" }).success).toBe(true);
    expect(AdkitJobCreateRequest.safeParse({ kind: "campaign.enable", brand_draft_id: "brand-a" }).success).toBe(false);
    expect(AdkitJobCreateRequest.safeParse({ kind: "conversion_action.create", brand_draft_id: "brand-a", idempotency_key: "short" }).success).toBe(false);
  });

  it("result carries either a result or an error, never both", () => {
    const result = { conversion_action_id: "7300000001", name: "cv-0123456789abcdef", adopted: false };
    expect(AdkitJobResultRequest.safeParse({ job_id: JOB, claim_id: CLAIM, result }).success).toBe(true);
    expect(AdkitJobResultRequest.safeParse({ job_id: JOB, claim_id: CLAIM, error: "boom", retryable: false }).success).toBe(true);
    expect(AdkitJobResultRequest.safeParse({ job_id: JOB, claim_id: CLAIM, result, error: "boom" }).success).toBe(false);
  });
});
