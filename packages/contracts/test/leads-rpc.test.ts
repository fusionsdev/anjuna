import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clickIdFromLeadId,
  HANDOFF_TTL_SECONDS,
  IssueHandoffRequest,
  IssueHandoffResponse,
  LeadsRpc,
  BrandSettingsRequest,
  BrandSettingsResponse,
  RecordClickRequest,
  RecordClickResponse,
  ResolveContinuationRequest,
  ResolveContinuationResponse,
  RpcError,
  SubmitLeadRequest,
  SubmitLeadResponse,
  VerifyHandoffRequest,
  VerifyHandoffResponse,
  ZipRequest,
  ZipRpcResponse,
  type FormLeadPayload,
  type SubmitLeadRequest as SubmitLeadRequestT,
} from "../src/index.js";
import { fixture } from "./helpers.js";
import * as V1 from "./v1/validate-lead.v1.js";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T15:04:05.000Z"));
});
afterAll(() => vi.useRealTimers());

function submitRequest(lead: FormLeadPayload): SubmitLeadRequestT {
  return {
    brand_id: "brand-a",
    hostname: "brand-a.example",
    click_session_id: "3f9a1c7e5b2d4086a1f3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7",
    client: { ip: "203.0.113.7", user_agent: "Mozilla/5.0" },
    experiment_id: "exp-2026-10",
    variant: "a",
    lead,
  };
}

describe("LeadsRpc routing table", () => {
  it("has the six T3 methods, live brandSettings and brandAsset under /rpc/", () => {
    expect(Object.keys(LeadsRpc)).toEqual(["recordClick", "submitLead", "resolveContinuation", "zip", "issueHandoff", "verifyHandoff", "brandSettings", "brandAsset"]);
    for (const [name, def] of Object.entries(LeadsRpc)) expect(def.path).toBe(`/rpc/${name}`);
  });
});

describe("brandSettings", () => {
  it("parses the public golden and rejects extra secret fields", () => {
    expect(BrandSettingsRequest.parse(fixture("rpc/brandSettings.request.json"))).toEqual({ brand_id: "brand-a" });
    const data = fixture<object>("rpc/brandSettings.response.json");
    expect(BrandSettingsResponse.parse(data)).toEqual(data);
    for (const key of ["postback_token_hash", "aid", "account", "drain_key", "HANDOFF_KEY", "prepop_base"]) {
      expect(BrandSettingsResponse.safeParse({ ...data, [key]: "private" }).success).toBe(false);
    }
  });
});

describe("brandSettings site text", () => {
  it("site text is optional on the wire and validated when present", () => {
    const data = fixture<object>("rpc/brandSettings.response.json");
    expect(BrandSettingsResponse.parse({ ...data, brand_name: "Quick Funds", site_title: null, site_description: null })).toMatchObject({ brand_name: "Quick Funds" });
    expect(BrandSettingsResponse.safeParse({ ...data, site_title: "Personal Loans" }).success).toBe(false);
    expect(BrandSettingsRequest.parse({ brand_id: "brand-a", include_site_text: true })).toEqual({ brand_id: "brand-a", include_site_text: true });
    expect(BrandSettingsRequest.safeParse({ brand_id: "brand-a", include_site_text: false }).success).toBe(false);
  });

  it("the old strict response shape still parses a legacy response", () => {
    const OldShape = BrandSettingsResponse.omit({ brand_name: true, site_title: true, site_description: true });
    const data = fixture<object>("rpc/brandSettings.response.json");
    expect(OldShape.strict().parse(data)).toEqual(data);
    expect(OldShape.strict().safeParse({ ...data, brand_name: "Quick Funds" }).success).toBe(false);
  });
});

describe("brandSettings theme", () => {
  it("brandSettings response accepts theme only as a valid BrandTheme or null", () => {
    const data = fixture<object>("rpc/brandSettings.response.json");
    const theme = { primary: "#0f766e", secondary: "#1e293b" };
    expect(BrandSettingsResponse.parse({ ...data, theme })).toMatchObject({ theme });
    expect(BrandSettingsResponse.parse({ ...data, theme: null })).toMatchObject({ theme: null });
    expect(BrandSettingsResponse.safeParse({ ...data, theme: { primary: "#fff", secondary: "#000000" } }).success).toBe(false);
    expect(BrandSettingsResponse.safeParse({ ...data, theme: { primary: "#0f766e" } }).success).toBe(false);
    expect(BrandSettingsRequest.parse({ brand_id: "brand-a", include_theme: true })).toEqual({ brand_id: "brand-a", include_theme: true });
    expect(BrandSettingsRequest.safeParse({ brand_id: "brand-a", include_theme: false }).success).toBe(false);
  });
});

describe("recordClick", () => {
  it("golden request/response parse", () => {
    expect(RecordClickRequest.safeParse(fixture("rpc/recordClick.request.json")).success).toBe(true);
    expect(RecordClickResponse.safeParse(fixture("rpc/recordClick.response.json")).success).toBe(true);
  });

  it("only allowlisted ad params are accepted (raw query never stored, V1 middleware rule)", () => {
    const req = fixture<Record<string, any>>("rpc/recordClick.request.json");
    expect(RecordClickRequest.safeParse({ ...req, params: { ...req.params, email: "x@example.com" } }).success).toBe(false);
  });

  it("brand_id and hostname are required and validated", () => {
    const req = fixture<Record<string, any>>("rpc/recordClick.request.json");
    expect(RecordClickRequest.safeParse({ ...req, brand_id: undefined }).success).toBe(false);
    expect(RecordClickRequest.safeParse({ ...req, hostname: "Brand-A.example:443" }).success).toBe(false);
  });
});

describe("submitLead", () => {
  it.each(["form/lead.full_v1.json", "form/lead.lite_v1.json"])("envelope around %s parses", (f) => {
    expect(SubmitLeadRequest.safeParse(submitRequest(fixture(f))).success).toBe(true);
  });

  it("click_session_id may be null (no cookie) but not missing", () => {
    const req = submitRequest(fixture("form/lead.full_v1.json"));
    expect(SubmitLeadRequest.safeParse({ ...req, click_session_id: null }).success).toBe(true);
    const { click_session_id: _drop, ...rest } = req;
    expect(SubmitLeadRequest.safeParse(rest).success).toBe(false);
  });

  it.each(["rpc/submitLead.response.accepted.json", "rpc/submitLead.response.duplicate.json", "rpc/submitLead.response.invalid.json"])(
    "%s parses",
    (f) => {
      expect(SubmitLeadResponse.safeParse(fixture(f)).success).toBe(true);
    },
  );

  it("reference is the last 8 chars of lead_id (V1)", () => {
    const r = SubmitLeadResponse.parse(fixture("rpc/submitLead.response.accepted.json"));
    if (!("reference" in r)) throw new Error("expected accepted");
    expect(r.reference).toBe(r.lead_id.slice(-8));
  });
});

describe("resolveContinuation", () => {
  it("golden request/responses parse", () => {
    expect(ResolveContinuationRequest.safeParse(fixture("rpc/resolveContinuation.request.json")).success).toBe(true);
    expect(ResolveContinuationResponse.safeParse(fixture("rpc/resolveContinuation.response.json")).success).toBe(true);
    expect(RpcError.safeParse(fixture("rpc/resolveContinuation.response.not-found.json")).success).toBe(true);
  });

  it("golden prepop URL is byte-identical to V1 buildUserRedirect for the full fixture", () => {
    const env: V1.Env = {
      FORM_SITE_ID: "aurum-default",
      FORM_VERSION: "2026-01",
      CONSENT_VERSION: "consent-2026-02",
      PARTNER_LIST_VERSION: "partners-2026-01",
      BUYER_MODE: "prepop_redirect",
      LEADSGATE_PREPOP_URL: "https://prepop.example/apply",
      ALLOWED_AIDS: "10001",
    };
    const v = V1.validateLeadPayload(fixture("form/lead.full_v1.json"), env);
    if (!v.ok) throw new Error(v.message);
    // V1 handleLead lines 365-367: our click id is lead_id without hyphens.
    const ownClickId = v.value.lead_id.replace(/-/g, "");
    v.value.tracking.click_id = ownClickId;
    v.value.tracking.clickid = ownClickId;
    expect(ownClickId).toBe(clickIdFromLeadId(v.value.lead_id));

    const url = V1.buildUserRedirect(v.value, env, true, "https://brand-a.example");
    expect(url).toBe(fixture<{ url: string }>("rpc/resolveContinuation.response.json").url);
  });
});

describe("zip", () => {
  it("golden request parses; response is the V1 zip body", () => {
    expect(ZipRequest.safeParse(fixture("rpc/zip.request.json")).success).toBe(true);
    expect(ZipRpcResponse.safeParse(fixture("form/zip.response.found.json")).success).toBe(true);
    expect(ZipRequest.safeParse({ brand_id: "brand-a", zip: "752011" }).success).toBe(false);
  });
});

describe("issueHandoff / verifyHandoff", () => {
  it("golden fixtures parse", () => {
    expect(IssueHandoffRequest.safeParse(fixture("rpc/issueHandoff.request.json")).success).toBe(true);
    expect(IssueHandoffResponse.safeParse(fixture("rpc/issueHandoff.response.json")).success).toBe(true);
    expect(VerifyHandoffRequest.safeParse(fixture("rpc/verifyHandoff.request.json")).success).toBe(true);
    expect(VerifyHandoffResponse.safeParse(fixture("rpc/verifyHandoff.response.valid.json")).success).toBe(true);
    expect(VerifyHandoffResponse.safeParse(fixture("rpc/verifyHandoff.response.expired.json")).success).toBe(true);
  });

  it("handoff lifetime is 30 minutes (BR-3)", () => {
    expect(HANDOFF_TTL_SECONDS).toBe(1800);
  });

  it("a valid verify must carry amount and ZIP", () => {
    expect(VerifyHandoffResponse.safeParse({ valid: true, zip: "75201", expires_at: "2026-10-02T15:34:05.000Z" }).success).toBe(false);
  });
});

describe("errors", () => {
  it("forbidden_brand is a distinct error (CO-2)", () => {
    expect(RpcError.parse(fixture("rpc/error.forbidden-brand.json")).error).toBe("forbidden_brand");
  });
});
