import { describe, expect, it } from "vitest";
import { BrandRevisionsResponse, DeployEvent, DeployHistoryQuery, DeployHistoryResponse, LifecycleBrandSummary } from "../src/index.js";
import deploysFixture from "../fixtures/admin/deploys.response.json";

const install = {
  source: "install", event_id: "inst-1", brand_id: "brand-a", operation: "install", action: null,
  status: "ready", from_revision_id: null, to_revision_id: "brand-a_rev_1", is_canary: false,
  started_by: "owner-1", started_role: "owner", started_at: "2026-10-20T01:00:00.000Z",
  finished_at: "2026-10-20T01:04:00.000Z", error: null,
};
const auditEvent = { ...install, source: "audit", event_id: "audit-7", operation: null, action: "brand.profile.update", status: "done", finished_at: null };

describe("DeployEvent", () => {
  it("accepts an install row and an audit row", () => {
    expect(DeployEvent.parse(install).operation).toBe("install");
    expect(DeployEvent.parse(auditEvent).action).toBe("brand.profile.update");
  });
  it("rejects an unknown key", () => {
    expect(DeployEvent.safeParse({ ...install, install_id: "inst-1" }).success).toBe(false);
  });
  it("rejects an audit row that carries an operation", () => {
    expect(DeployEvent.safeParse({ ...auditEvent, operation: "install" }).success).toBe(false);
  });
  it("rejects an install row with no operation and an audit row that is not done", () => {
    expect(DeployEvent.safeParse({ ...install, operation: null }).success).toBe(false);
    expect(DeployEvent.safeParse({ ...auditEvent, status: "ready" }).success).toBe(false);
  });
});

describe("DeployHistoryQuery", () => {
  it("coerces limit and bounds it to 1..200", () => {
    expect(DeployHistoryQuery.parse({ limit: "50" }).limit).toBe(50);
    expect(DeployHistoryQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(DeployHistoryQuery.safeParse({ limit: "201" }).success).toBe(false);
  });
  it("accepts an empty query and rejects an unknown key", () => {
    expect(DeployHistoryQuery.parse({})).toEqual({});
    expect(DeployHistoryQuery.safeParse({ brand_id: "brand-a" }).success).toBe(false);
  });
});

describe("the deploys fixture", () => {
  it("parses as a DeployHistoryResponse with four events", () => {
    const parsed = DeployHistoryResponse.parse(deploysFixture);
    expect(parsed.events).toHaveLength(4);
    expect(parsed.events.map((e) => e.status)).toContain("failed");
    expect(parsed.unavailable).toEqual([]);
  });
});

describe("BrandRevisionsResponse", () => {
  it("accepts a brand with one current revision and a rollback target", () => {
    const parsed = BrandRevisionsResponse.parse({
      brand_id: "brand-a", current_revision_id: "brand-a_rev_2", rollback_target_revision_id: "brand-a_rev_1",
      revisions: [{
        revision_id: "brand-a_rev_2", revision: 2, template_version_id: "tv-1", form_artifact_id: "fa-1",
        bundle_form_version: "form@abcdef1", worker_version_id: null, created_by: "owner-1",
        created_at: "2026-10-20T01:00:00.000Z", is_current: true,
      }],
    });
    expect(parsed.revisions[0]!.is_current).toBe(true);
  });
  it("rejects revision 0", () => {
    expect(BrandRevisionsResponse.safeParse({ brand_id: "brand-a", current_revision_id: null, rollback_target_revision_id: null, revisions: [{ revision_id: "r", revision: 0, template_version_id: "tv-1", form_artifact_id: "fa-1", bundle_form_version: null, worker_version_id: null, created_by: "o", created_at: "2026-10-20T01:00:00.000Z", is_current: false }] }).success).toBe(false);
  });
});

describe("LifecycleBrandSummary.latest_install", () => {
  const base = { brand_id: "brand-a", account: "acc", hostnames: ["a.test", "www.a.test"], status: "live", current_revision_id: "r1", runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01" };
  it("stays valid without the field, with null, and with a row", () => {
    expect(LifecycleBrandSummary.parse(base).latest_install).toBeUndefined();
    expect(LifecycleBrandSummary.parse({ ...base, latest_install: null }).latest_install).toBeNull();
    expect(LifecycleBrandSummary.parse({ ...base, latest_install: { install_id: "inst-1", operation: "redeploy", status: "failed", started_at: "2026-10-20T01:00:00.000Z", finished_at: null, started_by: "owner-1" } }).latest_install?.status).toBe("failed");
  });
});
