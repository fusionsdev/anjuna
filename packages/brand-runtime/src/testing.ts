import { AnalyticsForwardRequest, HANDOFF_TTL_SECONDS, LeadsRpc, type BrandAssetBody, type BrandAssetKind, type LeadsRpcMethod, type LeadsRpcRequest, type BrandSettingsResponse } from "@anjuna/contracts";
import type { PageTextData } from "./page-text.js";
import { CoreError, type AnalyticsRequest, type CoreClient, type CoreResult } from "./core-client.js";

/** In-memory fake: no network, crypto signing, persistence, or provider calls. */
export class MockCoreClient implements CoreClient {
  readonly calls: { [M in LeadsRpcMethod]: LeadsRpcRequest<M>[] } = {
    recordClick: [], submitLead: [], resolveContinuation: [], zip: [], issueHandoff: [], verifyHandoff: [], brandSettings: [], brandAsset: [],
  };
  readonly analytics: AnalyticsRequest[] = [];
  readonly continuations = new Map<string, string>();
  readonly handoffs = new Map<string, { brand_id: string; requested_amount: number; zip: string; expires_at: string }>();
  failure: Error | null = null;
  settings: BrandSettingsResponse | null = null;
  /** The favicon or logo core would return per kind. A kind without an entry answers 404. */
  readonly assets: Partial<Record<BrandAssetKind, BrandAssetBody>> = {};
  private sequence = 0;

  private record<M extends LeadsRpcMethod>(method: M, body: LeadsRpcRequest<M>) {
    const parsed = LeadsRpc[method].request.parse(body) as LeadsRpcRequest<M>;
    (this.calls[method] as LeadsRpcRequest<M>[]).push(parsed);
    if (this.failure) throw this.failure;
  }
  private token(prefix: string) { return `${prefix}_${String(++this.sequence).padStart(20, "0")}`; }

  async recordClick(body: LeadsRpcRequest<"recordClick">): Promise<CoreResult<"recordClick">> {
    this.record("recordClick", body);
    return { status: 200, data: { click_session_id: this.token("click") } };
  }
  async brandSettings(body: LeadsRpcRequest<"brandSettings">): Promise<CoreResult<"brandSettings">> {
    this.record("brandSettings", body);
    if (!this.settings) throw new CoreError(404);
    return { status: 200, data: this.settings };
  }
  async brandAsset(body: LeadsRpcRequest<"brandAsset">): Promise<CoreResult<"brandAsset">> {
    this.record("brandAsset", body);
    const asset = this.assets[body.kind];
    if (!asset) throw new CoreError(404);
    return { status: 200, data: asset };
  }
  async submitLead(body: LeadsRpcRequest<"submitLead">): Promise<CoreResult<"submitLead">> {
    this.record("submitLead", body);
    const continuation = this.token("continue");
    this.continuations.set(continuation, "https://provider.example/prepop?click_id=test");
    return { status: 201, data: { status: "accepted", lead_id: body.lead.lead_id, reference: body.lead.lead_id.slice(-8), continuation } };
  }
  async resolveContinuation(body: LeadsRpcRequest<"resolveContinuation">): Promise<CoreResult<"resolveContinuation">> {
    this.record("resolveContinuation", body);
    const url = this.continuations.get(body.token);
    if (!url) throw new CoreError(404);
    return { status: 200, data: { url } };
  }
  async zip(body: LeadsRpcRequest<"zip">): Promise<CoreResult<"zip">> {
    this.record("zip", body);
    return { status: 200, data: body.zip.padStart(5, "0") === "60601"
      ? { found: true, zip: "60601", city: "Chicago", state: "IL" } : { found: false } };
  }
  async issueHandoff(body: LeadsRpcRequest<"issueHandoff">): Promise<CoreResult<"issueHandoff">> {
    this.record("issueHandoff", body);
    const token = this.token("handoff");
    const expires_at = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000).toISOString();
    this.handoffs.set(token, { ...body, expires_at });
    return { status: 200, data: { token, expires_at } };
  }
  async verifyHandoff(body: LeadsRpcRequest<"verifyHandoff">): Promise<CoreResult<"verifyHandoff">> {
    this.record("verifyHandoff", body);
    const handoff = this.handoffs.get(body.token);
    if (!handoff) return { status: 200, data: { valid: false, reason: "bad_signature" } };
    if (handoff.brand_id !== body.brand_id) return { status: 200, data: { valid: false, reason: "brand_mismatch" } };
    if (Date.parse(handoff.expires_at) <= Date.now()) return { status: 200, data: { valid: false, reason: "expired" } };
    const { brand_id: _, ...data } = handoff;
    return { status: 200, data: { valid: true, ...data } };
  }
  async forwardAnalytics(body: AnalyticsRequest): Promise<void> {
    this.analytics.push(AnalyticsForwardRequest.parse(body));
    if (this.failure) throw this.failure;
  }
}

// ---- FUS-364 page text fixture ---------------------------------------------------------------------------------

/** The Willow Lake Lending pattern seen live (FUS-364): brand in the FAQ, a tel: link in the header, H1 with data-kw. */
export const WILLOW_LAKE_INDEX = `<!doctype html><html><head><title>Willow Lake Lending | Loan Options</title>
<meta name="description" content="Willow Lake Lending helps you compare options."><meta property="og:title" content="Willow Lake Lending | Loan Options">
<meta property="og:site_name" content="Willow Lake Lending"></head>
<body><header><a href="/" data-brand>Willow Lake Lending</a> <a class="call" href="tel:+18337103200"><svg aria-hidden="true"><title>Phone</title></svg>(833) 710-3200</a></header>
<main><h1><span data-kw>Loan Options</span> from Willow Lake Lending</h1>
<p>Willow Lake Lending connects you with lenders in minutes.</p>
<form method="get" action="/go" data-cta><select name="requested_amount"><option value="1000">$1,000</option></select>
<input name="zip" inputmode="numeric" pattern="[0-9]{5}" minlength="5" maxlength="5" required><button type="submit">See Options</button></form>
<section class="faq"><h2>FAQ</h2><h3>What is Willow Lake Lending?</h3><p>Willow Lake Lending is a free matching service. Call (833) 710-3200 or write to help@willowlake.example.</p>
<img src="/logo.png" alt="Willow Lake Lending logo"></section>
<p class="rates">Term range: 91 days–72 months</p></main>
<footer><a href="mailto:help@willowlake.example">help@willowlake.example</a> &copy; Willow Lake Lending</footer>
<script type="application/ld+json">{"name":"Willow Lake Lending"}</script></body></html>`;
export const WILLOW_LAKE_TERMS = `<!doctype html><html><head><title>Terms | Willow Lake Lending</title></head><body>
<p>These terms apply to Willow Lake Lending. Questions: <a href="tel:833-710-3200">833-710-3200</a></p></body></html>`;

export const WIZARD_DEMO_PAGE_TEXT: PageTextData = {
  brand_name: "Wizard Demo",
  template_brand: "Willow Lake Lending",
  keyword_default: "Loan Options",
  profile: {
    copy: { h1: "{{keyword}} Options in Minutes", cta: "Check My Options", sub: "Answer two questions to see your options." },
    contact: { phone: "+1 (555) 010-0199", email: "care@wizard-demo.example", address: "1 Demo Way, Austin, TX" },
    disclosures: { term_min_months: 3, term_max_months: 36 },
  },
};
