import { AnalyticsForwardRequest, HANDOFF_TTL_SECONDS, LeadsRpc, type BrandAssetBody, type BrandAssetKind, type LeadsRpcMethod, type LeadsRpcRequest, type BrandSettingsResponse } from "@anjuna/contracts";
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
