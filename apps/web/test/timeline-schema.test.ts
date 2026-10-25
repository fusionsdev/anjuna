import { describe, expect, it } from "vitest";
import type { DeployEvent } from "@anjuna/contracts";
import {
  ADS_EVENT_TYPES,
  CHANGE_CATEGORIES,
  AdsAccountEvent,
  CreateAdsEventRequest,
  TimelineItem,
  TimelineQuery,
  changeCategory,
} from "../src/shared/timeline";

const change = (over: Partial<DeployEvent>): DeployEvent => ({
  source: "audit",
  event_id: "audit-1",
  brand_id: "b1",
  operation: null,
  action: "brand.update",
  status: "done",
  from_revision_id: null,
  to_revision_id: null,
  is_canary: false,
  started_by: "u1",
  started_role: "owner",
  started_at: "2026-10-21T00:00:00.000Z",
  finished_at: null,
  error: null,
  ...over,
});

const adsEvent = {
  event_id: "e1",
  brand_id: "b1",
  type: "ad_disapproved",
  occurred_at: "2026-10-21T01:00:00.000Z",
  note: "limited by policy",
  created_by: "u1",
  created_role: "employee",
  created_at: "2026-10-21T01:05:00.000Z",
};

describe("timeline schemas", () => {
  it("exposes the six event types and four change categories", () => {
    expect([...ADS_EVENT_TYPES]).toEqual(["ad_disapproved", "account_suspended", "account_reinstated", "policy_warning", "bot_visit_observed", "other"]);
    expect([...CHANGE_CATEGORIES]).toEqual(["config", "pause_resume", "deploy", "factory_edit"]);
  });

  it("TimelineQuery parses types, limit and range", () => {
    const q = TimelineQuery.parse({
      types: "config,ad_disapproved,config",
      limit: "50",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
    });
    expect(q.types).toEqual(["config", "ad_disapproved"]);
    expect(q.limit).toBe(50);
    expect(q.from).toBe("2026-10-01T00:00:00.000Z");
    expect(TimelineQuery.parse({ types: "" }).types).toBeUndefined();
    expect(TimelineQuery.parse({}).types).toBeUndefined();
    expect(TimelineQuery.parse({ limit: "1" }).limit).toBe(1);
    expect(TimelineQuery.parse({ limit: "200" }).limit).toBe(200);
  });

  it("TimelineQuery rejects an unknown type, limit 201 and from after to", () => {
    expect(TimelineQuery.safeParse({ types: "config,bogus" }).success).toBe(false);
    expect(TimelineQuery.safeParse({ limit: "201" }).success).toBe(false);
    expect(TimelineQuery.safeParse({ limit: "0" }).success).toBe(false);
    const r = TimelineQuery.safeParse({ from: "2026-10-02T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === "from")).toBe(true);
    expect(TimelineQuery.safeParse({ extra: "x" }).success).toBe(false);
  });

  it("TimelineItem accepts a change item and an ads_event item and rejects an extra key", () => {
    const changeItem = {
      kind: "change",
      item_id: "audit-1",
      at: "2026-10-21T00:00:00.000Z",
      category: "config",
      change: change({}),
      from_revision: null,
      to_revision: { revision: 2, template_version_id: "tv-2", bundle_form_version: null },
    };
    const eventItem = { kind: "ads_event", item_id: "ads-e1", at: adsEvent.occurred_at, event: adsEvent };
    expect(TimelineItem.safeParse(changeItem).success).toBe(true);
    expect(TimelineItem.safeParse(eventItem).success).toBe(true);
    expect(TimelineItem.safeParse({ ...changeItem, extra: 1 }).success).toBe(false);
    expect(TimelineItem.safeParse({ ...eventItem, extra: 1 }).success).toBe(false);
  });

  it("AdsAccountEvent allows only owner or employee as created_role", () => {
    expect(AdsAccountEvent.safeParse(adsEvent).success).toBe(true);
    expect(AdsAccountEvent.safeParse({ ...adsEvent, created_role: "system" }).success).toBe(false);
    expect(AdsAccountEvent.safeParse({ ...adsEvent, note: "x".repeat(501) }).success).toBe(false);
  });

  it("changeCategory maps install, brand.update, brand.pause, brand.resume and brand.create", () => {
    expect(changeCategory(change({ source: "install", operation: "install", action: null, status: "ready" }))).toBe("deploy");
    expect(changeCategory(change({ action: "brand.update" }))).toBe("config");
    expect(changeCategory(change({ action: "brand.pause" }))).toBe("pause_resume");
    expect(changeCategory(change({ action: "brand.resume" }))).toBe("pause_resume");
    expect(changeCategory(change({ action: "brand.create" }))).toBe("factory_edit");
  });

  it("CreateAdsEventRequest rejects an unknown type and a missing note", () => {
    const ok = { type: "other", occurred_at: "2026-10-21T01:00:00.000Z", note: "x" };
    expect(CreateAdsEventRequest.safeParse(ok).success).toBe(true);
    expect(CreateAdsEventRequest.safeParse({ ...ok, type: "bogus" }).success).toBe(false);
    expect(CreateAdsEventRequest.safeParse({ type: ok.type, occurred_at: ok.occurred_at }).success).toBe(false);
    expect(CreateAdsEventRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});
