import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApplyRuntimeRequest,
  ApplyRuntimeResponse,
  RuntimeStateResponse,
  VerifySoldLeadResponse,
  type AdminRequestContext,
  type ApplyRuntimeRequest as ApplyRequest,
} from "@anjuna/contracts";
import { createHarness, type Harness } from "./helpers.js";

const owner: AdminRequestContext = {
  actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_lifecycle_01",
};
const employee: AdminRequestContext = {
  actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_lifecycle_02",
};

const initialRuntime = {
  drain_key: "brand-a", aid: "10001", prepop_base: "https://prepop.example/apply",
  amount_buckets: [500, 1000, 1500], form_route: "/request",
  keyword_default: "Fast Cash Loans", form_version: "form@8ba11d3",
};

function apply(overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return ApplyRuntimeRequest.parse({
    install_id: "install-1", brand_id: "brand-a", account: "account-a",
    hostnames: ["brand-a.example", "www.brand-a.example"], expected_revision_id: null,
    target_revision_id: "revision-1", actor_id: owner.actor_id, actor_role: owner.actor_role,
    initial_runtime: initialRuntime, ...overrides,
  });
}

function jsonBody(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.seedAccount("account-a", "account-a-token");
  await h.seedBrand("brand-a", "brand-token", "account-a");
  await h.factory.prepare(`INSERT INTO brands
    (brand_id, name, account, domain, status, created_by, created_at, updated_at)
    VALUES ('new-brand', 'New Brand', 'account-a', 'new-brand.example', 'draft', 'usr_owner_01', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z')`).run();
  await h.db.prepare(`UPDATE brand_runtime SET
    amount_buckets = '[500,1000,1500]', flow_gate_mode = 'signed_cookie',
    ab_config_json = '{"experiment_id":"exp-1","variants":[{"id":"A","weight":50},{"id":"B","weight":50}]}',
    keyword_default = 'Existing Keyword', form_route = '/existing', aid = 'existing-aid',
    prepop_base = 'https://existing.example/apply', applied_revision_id = 'revision-1',
    last_lifecycle_install_id = 'install-1', form_version = 'form@8ba11d3' WHERE brand_id = 'brand-a'`).run();
});
afterAll(async () => { await h?.mf.dispose(); });

describe("private factory lifecycle service", () => {
  it("serves runtime-list through the real PanelLifecycleService handler", async () => {
    const response = await h.panelLifecycle("/runtime-list", owner, jsonBody({ account: "account-a" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      brands: [expect.objectContaining({ brand_id: "brand-a", account: "account-a" })],
    });
  });

  it("provisions the first runtime and records one core audit row", async () => {
    await h.db.prepare("DELETE FROM brand_runtime WHERE brand_id = 'new-brand'").run();
    const request = apply({ brand_id: "new-brand", account: "account-a", hostnames: ["new-brand.example"], initial_runtime: initialRuntime });
    const response = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(request));
    expect(response.status).toBe(200);
    expect(ApplyRuntimeResponse.parse(await response.json())).toMatchObject({ state: "applied", applied_revision_id: "revision-1", paused: false });
    const row = await h.db.prepare("SELECT account, aid, prepop_base, amount_buckets, form_route, keyword_default, form_version, applied_revision_id, paused FROM brand_runtime WHERE brand_id = 'new-brand'").first();
    expect(row).toMatchObject({ account: "account-a", aid: "10001", prepop_base: "https://prepop.example/apply", amount_buckets: "[500,1000,1500]", form_route: "/request", keyword_default: "Fast Cash Loans", form_version: "form@8ba11d3", applied_revision_id: "revision-1", paused: 0 });
    expect(Number((await h.factory.prepare("SELECT count(*) AS count FROM audit_log WHERE entity_id = 'new-brand'").first<{ count: number }>())!.count)).toBe(1);
  });

  it("rejects first provisioning when Factory has no authoritative brand ownership", async () => {
    const response = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({
      brand_id: "unowned-brand", install_id: "install-unowned",
    })));
    expect(response.status).toBe(403);
    expect(await h.db.prepare("SELECT brand_id FROM brand_runtime WHERE brand_id = 'unowned-brand'").first()).toBeNull();
  });

  it("treats a same-install retry as a no-op without another audit row", async () => {
    const first = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply()));
    const before = Number((await h.factory.prepare("SELECT count(*) AS count FROM audit_log WHERE entity_id = 'brand-a'").first<{ count: number }>())!.count);
    const retry = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({ initial_runtime: undefined })));
    expect(first.status).toBe(200);
    expect(ApplyRuntimeResponse.parse(await retry.json())).toMatchObject({ state: "noop", install_id: "install-1" });
    expect(Number((await h.factory.prepare("SELECT count(*) AS count FROM audit_log WHERE entity_id = 'brand-a'").first<{ count: number }>())!.count)).toBe(before);
  });

  it("rejects a stale revision with 409 and preserves core-owned money routing", async () => {
    const response = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({ install_id: "install-2", expected_revision_id: "old-revision", target_revision_id: "revision-2", hostnames: ["brand-a.example"] })));
    expect(response.status).toBe(409);
    const row = await h.db.prepare("SELECT aid, prepop_base, amount_buckets, flow_gate_mode, ab_config_json, keyword_default, form_route, applied_revision_id FROM brand_runtime WHERE brand_id = 'brand-a'").first();
    expect(row).toMatchObject({ aid: "existing-aid", prepop_base: "https://existing.example/apply", amount_buckets: "[500,1000,1500]", flow_gate_mode: "signed_cookie", keyword_default: "Existing Keyword", form_route: "/existing", applied_revision_id: "revision-1" });
  });

  it("allows only one of two conflicting installs to win the compare-and-set", async () => {
    const before = Number((await h.factory.prepare("SELECT count(*) AS count FROM audit_log WHERE entity_id = 'brand-a'").first<{ count: number }>())!.count);
    const [first, second] = await Promise.all([
      h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({ install_id: "install-race-a", expected_revision_id: "revision-1", target_revision_id: "revision-2" }))),
      h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({ install_id: "install-race-b", expected_revision_id: "revision-1", target_revision_id: "revision-3" }))),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(Number((await h.factory.prepare("SELECT count(*) AS count FROM audit_log WHERE entity_id = 'brand-a'").first<{ count: number }>())!.count)).toBe(before + 1);
    const row = await h.db.prepare("SELECT applied_revision_id, last_lifecycle_install_id FROM brand_runtime WHERE brand_id = 'brand-a'").first();
    expect(["revision-2", "revision-3"]).toContain(row!.applied_revision_id);
    expect(["install-race-a", "install-race-b"]).toContain(row!.last_lifecycle_install_id);
  });

  it("rejects a credential/account mismatch before touching runtime", async () => {
    const response = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({ account: "other-account", install_id: "install-other" })));
    expect(response.status).toBe(403);
  });

  it("preserves an operator pause while switching a runtime revision", async () => {
    await h.db.prepare("UPDATE brand_runtime SET paused=1 WHERE brand_id='brand-a'").run();
    const current = await h.db.prepare("SELECT applied_revision_id FROM brand_runtime WHERE brand_id='brand-a'").first<{ applied_revision_id: string }>();
    const response = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({ install_id: "install-paused", expected_revision_id: current!.applied_revision_id, target_revision_id: "revision-paused", initial_runtime: undefined })));
    expect(await response.json()).toMatchObject({ state: "applied", paused: true });
    expect(await h.db.prepare("SELECT paused FROM brand_runtime WHERE brand_id='brand-a'").first()).toEqual({ paused: 1 });
  });

  it("detaches by pausing while retaining hostnames and supports a runtime preflight", async () => {
    const current = await h.db.prepare("SELECT applied_revision_id FROM brand_runtime WHERE brand_id = 'brand-a'").first<{ applied_revision_id: string }>();
    const response = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({ install_id: "install-detach", expected_revision_id: current!.applied_revision_id, target_revision_id: null, initial_runtime: undefined })));
    expect(ApplyRuntimeResponse.parse(await response.json())).toMatchObject({ state: "detached", paused: true, applied_revision_id: null });
    const state = await h.factoryLifecycle("/runtime-state", "account-a-token", jsonBody({ brand_id: "brand-a", account: "account-a" }));
    expect(RuntimeStateResponse.parse(await state.json())).toMatchObject({ state: "applied", applied_revision_id: null, paused: true, last_lifecycle_install_id: "install-detach", bundle_form_version: "form@8ba11d3", credential_account_match: true });
    expect((await h.db.prepare("SELECT hostnames FROM brand_runtime WHERE brand_id = 'brand-a'").first<{ hostnames: string }>())!.hostnames).toBe(JSON.stringify(["brand-a.example", "www.brand-a.example"]));
  });

  it("returns absent for a valid account with no runtime and rejects wrong-account preflight", async () => {
    await h.db.prepare("DELETE FROM brand_runtime WHERE brand_id = 'missing-brand'").run();
    const absent = await h.factoryLifecycle("/runtime-state", "account-a-token", jsonBody({ brand_id: "missing-brand", account: "account-a" }));
    expect(RuntimeStateResponse.parse(await absent.json())).toEqual({ state: "absent", brand_id: "missing-brand", account: "account-a", credential_account_match: true });
    const forbidden = await h.factoryLifecycle("/runtime-state", "account-a-token", jsonBody({ brand_id: "missing-brand", account: "other-account" }));
    expect(forbidden.status).toBe(403);
  });

  it("accepts distinct form bundle identities through upgrade and rollback without external requests", async () => {
    const upgrade = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({
      install_id: "install-upgrade-bundle", expected_revision_id: null, target_revision_id: "revision-bundle-2",
      initial_runtime: { ...initialRuntime, form_version: "form@bundle-2" },
    })));
    expect(upgrade.status).toBe(200);
    expect(ApplyRuntimeResponse.parse(await upgrade.json())).toMatchObject({ state: "applied", applied_revision_id: "revision-bundle-2" });
    const rollback = await h.factoryLifecycle("/runtime", "account-a-token", jsonBody(apply({
      install_id: "install-rollback-bundle", expected_revision_id: "revision-bundle-2", target_revision_id: "revision-1",
      initial_runtime: { ...initialRuntime, form_version: "form@bundle-1" },
    })));
    expect(rollback.status).toBe(200);
    expect(ApplyRuntimeResponse.parse(await rollback.json())).toMatchObject({ state: "applied", applied_revision_id: "revision-1" });
    const state = await h.factoryLifecycle("/runtime-state", "account-a-token", jsonBody({ brand_id: "brand-a", account: "account-a" }));
    expect(RuntimeStateResponse.parse(await state.json())).toMatchObject({ applied_revision_id: "revision-1", bundle_form_version: "form@bundle-1" });
  });
});

describe("private panel Test-sold verification", () => {
  beforeAll(async () => {
    await h.seedLead("sold-lead", "cid-sold", "brand-a");
    await h.db.prepare("UPDATE leads SET status = 'soldLead' WHERE lead_id = 'sold-lead'").run();
    await h.db.prepare("INSERT INTO postback_events (lead_id, event_type, payout, created_at) VALUES ('sold-lead', 'soldLead', 40, '2026-10-06T01:02:03.000Z')").run();
    await h.seedLead("other-lead", "cid-other", "brand-b");
    await h.db.prepare("UPDATE leads SET status = 'soldLead' WHERE lead_id = 'other-lead'").run();
    await h.db.prepare("INSERT INTO postback_events (lead_id, event_type, payout, created_at) VALUES ('other-lead', 'soldLead', 40, '2026-10-06T01:02:04.000Z')").run();
  });

  it("verifies a matching soldLead for an Employee without returning PII", async () => {
    const response = await h.panelLifecycle("/test-sold", employee, jsonBody({ brand_id: "brand-a", lead_id: "sold-lead" }));
    expect(response.status).toBe(200);
    const body = VerifySoldLeadResponse.parse(await response.json());
    expect(body).toEqual({ verified: true, event_id: expect.any(String), event_at: "2026-10-06T01:02:03.000Z" });
    expect(JSON.stringify(body)).not.toContain("email");
    expect(JSON.stringify(body)).not.toContain("first_name");
  });

  it("rejects wrong-brand, missing, and non-soldLead events", async () => {
    expect((await h.panelLifecycle("/test-sold", owner, jsonBody({ brand_id: "brand-b", lead_id: "sold-lead" }))).status).toBe(404);
    expect((await h.panelLifecycle("/test-sold", owner, jsonBody({ brand_id: "brand-a", lead_id: "missing" }))).status).toBe(404);
    await h.seedLead("pending-lead", "cid-pending", "brand-a");
    await h.db.prepare("INSERT INTO postback_events (lead_id, event_type, payout, created_at) VALUES ('pending-lead', 'reject', 0, '2026-10-06T01:02:05.000Z')").run();
    expect((await h.panelLifecycle("/test-sold", owner, jsonBody({ brand_id: "brand-a", lead_id: "pending-lead" }))).status).toBe(404);
  });

  it("replays the same Test-sold verification idempotently", async () => {
    const first = await h.panelLifecycle("/test-sold", owner, jsonBody({ brand_id: "brand-a", lead_id: "sold-lead" }));
    const second = await h.panelLifecycle("/test-sold", owner, jsonBody({ brand_id: "brand-a", lead_id: "sold-lead" }));
    expect(await first.json()).toEqual(await second.json());
  });
});

describe("public core routing", () => {
  it("keeps public admin and lifecycle paths at 404", async () => {
    for (const path of ["/admin/brands", "/lifecycle/runtime", "/lifecycle/test-sold"]) {
      expect((await h.request(path)).status).toBe(404);
    }
  });
});
