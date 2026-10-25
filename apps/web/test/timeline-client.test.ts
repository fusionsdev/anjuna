import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeployEvent } from "@anjuna/contracts";
import { api, ApiError } from "../src/client/api";
import {
  ADS_EVENT_LABEL,
  ADS_EVENT_TONE,
  CHANGE_CATEGORY_LABEL,
  filtersToQuery,
  fmtSince,
  groupByDay,
  isNearChange,
  localInputNow,
  localInputToIso,
  normalizeTypes,
  parseTimelineSearch,
  sinceLastChange,
  timelineSearch,
  type TimelineFilters,
} from "../src/client/timeline";
import { ADS_EVENT_TYPES, CHANGE_CATEGORIES, type TimelineItem, type TimelineType } from "../src/shared/timeline";

// Every date below is built from local parts, so the expectations hold in any time zone. July avoids DST changes.
const local = (day: number, h = 0, min = 0, s = 0, ms = 0): Date => new Date(2026, 6, day, h, min, s, ms);
const ALL: TimelineType[] = [...CHANGE_CATEGORIES, ...ADS_EVENT_TYPES];

const changeItem = (id: string, at: Date): Extract<TimelineItem, { kind: "change" }> => {
  const iso = at.toISOString();
  const change: DeployEvent = {
    source: "audit", event_id: id, brand_id: "b1", operation: null, action: "brand.update", status: "done",
    from_revision_id: null, to_revision_id: null, is_canary: false, started_by: "u1", started_role: "owner",
    started_at: iso, finished_at: null, error: null,
  };
  return { kind: "change", item_id: id, at: iso, category: "config", change, from_revision: null, to_revision: null };
};

const eventItem = (id: string, at: Date): Extract<TimelineItem, { kind: "ads_event" }> => {
  const iso = at.toISOString();
  return {
    kind: "ads_event", item_id: `ads-${id}`, at: iso,
    event: { event_id: id, brand_id: "b1", type: "ad_disapproved", occurred_at: iso, note: "", created_by: "u1", created_role: "owner", created_at: iso },
  };
};

describe("timeline labels", () => {
  it("has a label and a tone for every event type and a label for every category", () => {
    for (const type of ADS_EVENT_TYPES) {
      expect(ADS_EVENT_LABEL[type]).toBeTruthy();
      expect(ADS_EVENT_TONE[type]).toBeTruthy();
    }
    for (const category of CHANGE_CATEGORIES) expect(CHANGE_CATEGORY_LABEL[category]).toBeTruthy();
    expect(ADS_EVENT_TONE).toMatchObject({ ad_disapproved: "bad", account_suspended: "bad", account_reinstated: "live", policy_warning: "warn", bot_visit_observed: "warn", other: "mute" });
  });

  it("uses the exact spec D2 and D5 label strings", () => {
    expect(ADS_EVENT_LABEL).toEqual({
      ad_disapproved: "โฆษณาถูกปฏิเสธ (Ad disapproved)",
      account_suspended: "บัญชีถูกระงับ (Account suspended)",
      account_reinstated: "บัญชีกลับมาใช้ได้ (Account reinstated)",
      policy_warning: "คำเตือนนโยบาย (Policy warning)",
      bot_visit_observed: "พบการเข้าชมของบอท (Bot visit observed)",
      other: "อื่น ๆ (Other)",
    });
    expect(CHANGE_CATEGORY_LABEL).toEqual({
      config: "แก้ค่าแบรนด์ (Config change)",
      pause_resume: "หยุด/เปิดแบรนด์ (Pause/Resume)",
      deploy: "ติดตั้ง/ย้อนกลับ (Deploy/Rollback)",
      factory_edit: "แก้ไขใน factory (Factory edit)",
    });
  });
});

describe("timeline filters in the URL", () => {
  it("parseTimelineSearch defaults to 30d and all types", () => {
    expect(parseTimelineSearch("")).toEqual({ range: "30d", types: ALL });
    expect(parseTimelineSearch("?range=bogus")).toEqual({ range: "30d", types: ALL });
    expect(timelineSearch({ range: "30d", types: ALL })).toBe("");
  });

  it("timelineSearch round-trips presets, custom dates and a type subset", () => {
    const cases: TimelineFilters[] = [
      { range: "30d", types: ALL },
      { range: "7d", types: ALL },
      { range: "90d", types: ["config", "other"] },
      { range: "all", types: ["deploy", "ad_disapproved"] },
      { range: { from: "2026-07-01", to: "2026-07-15" }, types: ALL },
      { range: { from: "2026-07-01", to: null }, types: ["pause_resume"] },
      { range: { from: null, to: "2026-07-15" }, types: ALL },
      { range: "30d", types: [] },
    ];
    for (const filters of cases) expect(parseTimelineSearch(timelineSearch(filters))).toEqual(filters);
    expect(timelineSearch({ range: "7d", types: ALL })).toBe("?range=7d");
    expect(timelineSearch({ range: { from: "2026-07-01", to: "2026-07-15" }, types: ["config", "other"] })).toBe("?from=2026-07-01&to=2026-07-15&types=config,other");
  });

  it("normalizeTypes dedupes and puts types in canonical order, so a non-canonical list round-trips through the URL", () => {
    expect(normalizeTypes(["other", "config", "other", "deploy", "ad_disapproved", "config"])).toEqual(["config", "deploy", "ad_disapproved", "other"]);
    expect(normalizeTypes([])).toEqual([]);
    expect(normalizeTypes([...ALL].reverse())).toEqual(ALL);
    const filters: TimelineFilters = { range: "7d", types: normalizeTypes(["other", "bot_visit_observed", "factory_edit", "config"]) };
    expect(filters.types).toEqual(["config", "factory_edit", "bot_visit_observed", "other"]);
    expect(parseTimelineSearch(timelineSearch(filters))).toEqual(filters);
  });

  it("unknown type ids and bad dates are dropped", () => {
    expect(parseTimelineSearch("?types=config,bogus,other").types).toEqual(["config", "other"]);
    expect(parseTimelineSearch("?from=2026-02-30&to=nope").range).toEqual({ from: null, to: null });
    expect(parseTimelineSearch("?from=2026-07-01&to=2026-13-01").range).toEqual({ from: "2026-07-01", to: null });
  });

  it("filtersToQuery: 7d preset counts back 7 days; custom dates are local day bounds; all types omits types", () => {
    const now = local(20, 15, 30);
    expect(filtersToQuery({ range: "7d", types: ALL }, now)).toEqual({ from: new Date(now.getTime() - 7 * 24 * 3600_000).toISOString() });
    expect(filtersToQuery({ range: "90d", types: ALL }, now).from).toBe(new Date(now.getTime() - 90 * 24 * 3600_000).toISOString());
    expect(filtersToQuery({ range: "all", types: ALL }, now)).toEqual({});
    expect(filtersToQuery({ range: { from: "2026-07-01", to: "2026-07-15" }, types: ALL }, now)).toEqual({
      from: local(1, 0, 0, 0, 0).toISOString(),
      to: local(15, 23, 59, 59, 999).toISOString(),
    });
    expect(filtersToQuery({ range: { from: null, to: "2026-07-15" }, types: ALL }, now)).toEqual({ to: local(15, 23, 59, 59, 999).toISOString() });
    expect(filtersToQuery({ range: "all", types: ["other", "config"] }, now)).toEqual({ types: "config,other" });
    expect(filtersToQuery({ range: "all", types: [] }, now)).toEqual({});
    const query = filtersToQuery({ range: "7d", types: ALL }, now);
    expect(query.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect("limit" in query).toBe(false);
  });
});

describe("timeline grouping and markers", () => {
  it("groupByDay splits at local midnight and keeps order", () => {
    const a = changeItem("a", local(16, 0, 1));
    const b = eventItem("b", local(15, 23, 59));
    const c = changeItem("c", local(15, 8, 0));
    const d = changeItem("d", local(14, 12, 0));
    expect(groupByDay([a, b, c, d]).map((g) => ({ day: g.day, ids: g.items.map((i) => i.item_id) }))).toEqual([
      { day: "2026-07-16", ids: ["a"] },
      { day: "2026-07-15", ids: ["ads-b", "c"] },
      { day: "2026-07-14", ids: ["d"] },
    ]);
    expect(groupByDay([])).toEqual([]);
  });

  it("sinceLastChange picks the newest earlier change, ignores a later one, and gives no entry without an earlier change", () => {
    const oldChange = changeItem("old", local(10, 9, 0));
    const newChange = changeItem("new", local(12, 9, 0));
    const laterChange = changeItem("later", local(14, 9, 0));
    const event = eventItem("e1", local(12, 21, 0));
    const same = eventItem("e2", local(12, 9, 0));
    const before = eventItem("e3", local(9, 9, 0));
    const map = sinceLastChange([laterChange, event, same, newChange, oldChange, before]);
    expect(map.get("ads-e1")?.change.item_id).toBe("new");
    expect(map.get("ads-e1")?.ms).toBe(12 * 3600_000);
    expect(map.get("ads-e2")?.change.item_id).toBe("new");
    expect(map.get("ads-e2")?.ms).toBe(0);
    expect(map.has("ads-e3")).toBe(false);
    expect(map.has("later")).toBe(false);
    expect(sinceLastChange([event]).size).toBe(0);
  });

  it("fmtSince formats 45 s, 5 min, 3 h 10 min, 3 days", () => {
    expect(fmtSince(45_000)).toBe("45 วิ (45s)");
    expect(fmtSince(5 * 60_000)).toBe("5 นาที (5m)");
    expect(fmtSince(5 * 60_000 + 7_000)).toBe("5 นาที 7 วิ (5m 7s)");
    expect(fmtSince((3 * 60 + 10) * 60_000)).toBe("3 ชม. 10 นาที (3h 10m)");
    expect(fmtSince(3 * 3600_000)).toBe("3 ชม. (3h)");
    expect(fmtSince(47 * 3600_000 + 59 * 60_000)).toBe("47 ชม. 59 นาที (47h 59m)");
    expect(fmtSince(48 * 3600_000)).toBe("2 วัน (2d)");
    expect(fmtSince(3 * 24 * 3600_000)).toBe("3 วัน (3d)");
    expect(fmtSince((3 * 24 + 5) * 3600_000)).toBe("3 วัน 5 ชม. (3d 5h)");
    expect(fmtSince(-5_000)).toBe("—");
  });

  it("isNearChange is true up to 24 hours", () => {
    expect(isNearChange(24 * 3600_000)).toBe(true);
    expect(isNearChange(24 * 3600_000 + 1)).toBe(false);
  });
});

describe("datetime-local helpers", () => {
  it("localInputToIso round-trips localInputNow", () => {
    const now = local(15, 14, 5, 33, 123);
    expect(localInputNow(now)).toBe("2026-07-15T14:05");
    expect(localInputToIso(localInputNow(now))).toBe(local(15, 14, 5).toISOString());
    expect(localInputToIso("2026-07-15T14:05:30")).toBe(local(15, 14, 5, 30).toISOString());
  });

  it("localInputToIso rejects a value that is not a real local time", () => {
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("2026-07-15")).toBeNull();
    expect(localInputToIso("2026-02-30T10:00")).toBeNull();
    expect(localInputToIso("2026-07-15T25:00")).toBeNull();
  });
});

describe("timeline api methods", () => {
  const storedEvent = {
    event_id: "e/1", brand_id: "b1", type: "other", occurred_at: "2026-07-15T01:00:00.000Z", note: "n",
    created_by: "u1", created_role: "owner", created_at: "2026-07-15T01:00:01.000Z",
  };
  const stubFetch = (status: number, body: unknown) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("brandTimeline encodes the brand id, sends only set query values and parses the response", async () => {
    const fetchMock = stubFetch(200, { brand_id: "b1", items: [], has_more: false, unavailable: [], actor_scope: "all" });
    const result = await api.brandTimeline("b/1", { from: "2026-07-01T00:00:00.000Z", types: "", limit: undefined });
    expect(result.items).toEqual([]);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/brands/b%2F1/timeline?from=2026-07-01T00%3A00%3A00.000Z");
    expect(init.method).toBe("GET");
    await api.brandTimeline("b1", {});
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("/api/brands/b1/timeline");
    await api.brandTimeline("b1", { types: "config,other", limit: 50 });
    expect((fetchMock.mock.calls[2] as unknown as [string])[0]).toBe("/api/brands/b1/timeline?types=config%2Cother&limit=50");
  });

  it("brandTimeline rejects a response that does not match the schema", async () => {
    stubFetch(200, { brand_id: "b1", items: [], has_more: false });
    await expect(api.brandTimeline("b1")).rejects.toThrow();
    stubFetch(404, { error: "not_found", resource: "brand" });
    await expect(api.brandTimeline("b1")).rejects.toBeInstanceOf(ApiError);
  });

  it("createAdsEvent posts the body and parses the event; deleteAdsEvent encodes both ids", async () => {
    const fetchMock = stubFetch(201, { event: storedEvent });
    const body = { type: "other", occurred_at: storedEvent.occurred_at, note: "n" } as const;
    expect((await api.createAdsEvent("b/1", body)).event_id).toBe("e/1");
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/brands/b%2F1/ads-events");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(body);

    const deleteMock = stubFetch(200, { deleted: storedEvent });
    expect((await api.deleteAdsEvent("b/1", "e/1")).event_id).toBe("e/1");
    const [deletePath, deleteInit] = deleteMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(deletePath).toBe("/api/brands/b%2F1/ads-events/e%2F1");
    expect(deleteInit.method).toBe("DELETE");

    stubFetch(403, { error: "forbidden_role" });
    await expect(api.deleteAdsEvent("b1", "e1")).rejects.toBeInstanceOf(ApiError);
  });
});
