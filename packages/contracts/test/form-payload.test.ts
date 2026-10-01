import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BrandLeadResponse,
  BUYER_FIELDS,
  FORM_TRACKING_KEYS,
  FormLeadPayload,
  LeadError,
  V1_FORM_VARIANTS,
  V1_SERVER_TRACKING_KEYS,
  ZipResponse,
} from "../src/index.js";
import { fixture } from "./helpers.js";
import * as V1 from "./v1/validate-lead.v1.js";

/** The env values V1 production validated against (FORM_CONFIG in aurum-form @ 8ba11d3). */
const V1_ENV: V1.Env = {
  FORM_SITE_ID: "aurum-default",
  FORM_VERSION: "2026-01",
  CONSENT_VERSION: "consent-2026-02",
  PARTNER_LIST_VERSION: "partners-2026-01",
};

const FULL = "form/lead.full_v1.json";
const LITE = "form/lead.lite_v1.json";

// V1 checks age and next-payday against "today"; pin today to the fixtures' submit date.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T15:04:05.000Z"));
});
afterAll(() => vi.useRealTimers());

describe("V1 form payload (submitLead.lead)", () => {
  it.each([FULL, LITE])("%s matches the contract schema", (f) => {
    expect(FormLeadPayload.safeParse(fixture(f)).success).toBe(true);
  });

  it.each([FULL, LITE])("%s is accepted by the real V1 validateLeadPayload", (f) => {
    const r = V1.validateLeadPayload(fixture(f), V1_ENV);
    expect(r).toMatchObject({ ok: true });
  });

  it("fixtures use the two variants the V1 form emits", () => {
    expect(fixture<{ form_variant: string }>(FULL).form_variant).toBe(V1_FORM_VARIANTS.FULL);
    expect(fixture<{ form_variant: string }>(LITE).form_variant).toBe(V1_FORM_VARIANTS.LITE);
  });

  it("lead keys are exactly the LeadsGate buyer fields, in V1 order", () => {
    expect(Object.keys(fixture<{ lead: object }>(FULL).lead)).toEqual([...BUYER_FIELDS]);
    expect([...BUYER_FIELDS]).toEqual([...V1.BUYER_FIELDS]);
  });

  it("server tracking keys = V1 core TRACKING_KEYS; form keys add only ref_id", () => {
    expect([...V1_SERVER_TRACKING_KEYS]).toEqual([...V1.TRACKING_KEYS]);
    expect(FORM_TRACKING_KEYS.filter((k) => !(V1.TRACKING_KEYS as readonly string[]).includes(k))).toEqual(["ref_id"]);
  });

  it("V1 keeps every tracking key the fixture sends", () => {
    const r = V1.validateLeadPayload(fixture(FULL), V1_ENV);
    if (!r.ok) throw new Error(r.message);
    expect(r.value.tracking).toEqual(fixture<{ tracking: object }>(FULL).tracking);
  });

  type Mutation = [string, (p: Record<string, any>) => void, string];
  const breaks: Mutation[] = [
    ["bad lead_id", (p) => { p.lead_id = "not-a-uuid"; }, "Invalid identifiers"],
    ["missing consent", (p) => { p.consent.application_consent = false; }, "Consent required"],
    ["ZIP not 5 digits", (p) => { p.lead.zip = "1234"; }, "Invalid ZIP code"],
  ];
  it.each(breaks)("schema and V1 both reject: %s", (_name, mutate, v1Message) => {
    const p = structuredClone(fixture<Record<string, any>>(LITE));
    mutate(p);
    expect(FormLeadPayload.safeParse(p).success).toBe(false);
    expect(V1.validateLeadPayload(p, V1_ENV)).toEqual({ ok: false, message: v1Message });
  });

  it("rejects unknown top-level keys (no brand_id smuggling from the browser)", () => {
    expect(FormLeadPayload.safeParse({ ...fixture<object>(FULL), brand_id: "other" }).success).toBe(false);
  });

  it("rejects tracking keys outside the form allowlist", () => {
    const p = structuredClone(fixture<Record<string, any>>(FULL));
    p.tracking.raw_query = "x";
    expect(FormLeadPayload.safeParse(p).success).toBe(false);
  });
});

describe("brand /api/leads and /api/zip responses", () => {
  it.each(["form/leads.response.accepted.json", "form/leads.response.duplicate.json", "form/leads.response.invalid.json"])(
    "%s parses",
    (f) => {
      expect(BrandLeadResponse.safeParse(fixture(f)).success).toBe(true);
    },
  );

  it("accepted redirect_url is the provider hop, never a prepop URL", () => {
    const r = BrandLeadResponse.parse(fixture("form/leads.response.accepted.json"));
    expect("redirect_url" in r && r.redirect_url.startsWith("/request/provider?c=")).toBe(true);
  });

  it("invalid uses the V1 error shape", () => {
    expect(LeadError.parse(fixture("form/leads.response.invalid.json"))).toEqual({ status: "invalid", message: "Invalid ZIP code" });
  });

  it.each(["form/zip.response.found.json", "form/zip.response.not-found.json"])("%s parses", (f) => {
    expect(ZipResponse.safeParse(fixture(f)).success).toBe(true);
  });
});
