import type { DeployEvent } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { BrandTimelineScreen } from "../src/client/screens/BrandTimeline";
import type { TimelineItem, TimelineResponse } from "../src/shared/timeline";

const owner: Me = { id: "owner", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "employee", email: "employee@example.test", role: "employee" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Local dates in July, so the day groups and the clock times hold in any time zone and no DST change falls inside.
const local = (day: number, h: number, min = 0): Date => new Date(2026, 6, day, h, min);
const HEADING = (date: Date) => date.toLocaleDateString("th-TH", { dateStyle: "long" });

const installChange = (id: string, at: Date, over: Partial<DeployEvent> = {}): Extract<TimelineItem, { kind: "change" }> => ({
  kind: "change", item_id: id, at: at.toISOString(), category: "deploy",
  change: {
    source: "install", event_id: id, brand_id: "b1", operation: "redeploy", action: null, status: "ready",
    from_revision_id: "b1_rev_1", to_revision_id: "b1_rev_2", is_canary: false, started_by: "owner-1", started_role: "owner",
    started_at: at.toISOString(), finished_at: new Date(at.getTime() + 60_000).toISOString(), error: null, ...over,
  },
  from_revision: { revision: 1, template_version_id: "tpl-v1", bundle_form_version: "form@aaa1111" },
  to_revision: { revision: 2, template_version_id: "tpl-v2", bundle_form_version: "form@bbb2222" },
});

const configChange = (id: string, at: Date): Extract<TimelineItem, { kind: "change" }> => ({
  kind: "change", item_id: id, at: at.toISOString(), category: "config",
  change: {
    source: "audit", event_id: id, brand_id: "b1", operation: null, action: "brand.update", status: "done",
    from_revision_id: null, to_revision_id: null, is_canary: false, started_by: "employee-1", started_role: "employee",
    started_at: at.toISOString(), finished_at: null, error: null,
  },
  from_revision: null, to_revision: null,
});

const adsEvent = (id: string, at: Date, type: Extract<TimelineItem, { kind: "ads_event" }>["event"]["type"], note: string): Extract<TimelineItem, { kind: "ads_event" }> => ({
  kind: "ads_event", item_id: `ads-${id}`, at: at.toISOString(),
  event: { event_id: id, brand_id: "b1", type, occurred_at: at.toISOString(), note, created_by: "owner-1", created_role: "owner", created_at: at.toISOString() },
});

// Newest first, as the route answers. e1 is 2 h after inst-2; e2 is 30 h after cfg-1 and has no later-loaded change before it.
const ITEMS: TimelineItem[] = [
  adsEvent("e1", local(22, 12), "ad_disapproved", "โฆษณาหลักถูกปฏิเสธ"),
  installChange("inst-2", local(22, 10)),
  adsEvent("e2", local(21, 15), "account_suspended", ""),
  configChange("cfg-1", local(20, 9)),
];

const response = (over: Partial<TimelineResponse> = {}): TimelineResponse => ({
  brand_id: "b1", items: ITEMS, has_more: false, unavailable: [], actor_scope: "all", ...over,
});

let requests: URL[];
let respond: (url: URL) => Response | Promise<Response>;
const timelineCalls = () => requests.filter((url) => url.pathname === "/api/brands/b1/timeline");
const lastCall = () => timelineCalls().at(-1)!;
const rowIds = () => [...document.querySelectorAll(".tl-row")].map((row) => row.id);
const row = (id: string) => document.getElementById(`tl-${id}`)!;

beforeEach(() => {
  window.history.replaceState(null, "", "/brands/b1/timeline");
  requests = [];
  respond = () => json(response());
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, window.location.origin);
    requests.push(url);
    if (url.pathname === "/api/brands/b1/timeline") return respond(url);
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "b1", hostnames: ["shop.example"] }] });
    if (url.pathname === "/api/brands") return json({ brands: [], generated_at: "2026-07-22T00:00:00.000Z" });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const open = async (me: Me = owner) => {
  render(<BrandTimelineScreen me={me} brandId="b1" />);
  await screen.findByText("โฆษณาหลักถูกปฏิเสธ");
};

describe("brand timeline screen", () => {
  it("renders change and event rows grouped by day with distinct markers", async () => {
    await open();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ไทม์ไลน์แบรนด์ (Brand timeline)");
    expect(screen.getByText("shop.example")).toBeTruthy();
    expect(screen.getByRole("link", { name: "กลับไปที่แบรนด์ (Back to brand)" }).getAttribute("href")).toBe("/brands/b1");
    // Three local days, newest first, each with the th-TH long date.
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([HEADING(local(22, 12)), HEADING(local(21, 15)), HEADING(local(20, 9))]);
    expect(rowIds()).toEqual(["tl-ads-e1", "tl-inst-2", "tl-ads-e2", "tl-cfg-1"]);
    // Square marker on changes, round tone marker on events.
    expect([...document.querySelectorAll(".tl-marker-change")].map((m) => m.closest("li")!.id)).toEqual(["tl-inst-2", "tl-cfg-1"]);
    expect([...document.querySelectorAll(".tl-marker-event")].map((m) => m.closest("li")!.id)).toEqual(["tl-ads-e1", "tl-ads-e2"]);
    expect(row("ads-e1").querySelector(".tl-marker-event")!.classList.contains("tl-tone-bad")).toBe(true);
    expect(row("ads-e1").querySelector(".tl-marker-change")).toBeNull();
    expect(row("inst-2").querySelector(".tl-marker-event")).toBeNull();
    // A change row: category, operation, status badge, actor and role, local clock time.
    const install = within(row("inst-2"));
    expect(install.getByText("ติดตั้ง/ย้อนกลับ (Deploy/Rollback)")).toBeTruthy();
    expect(install.getByText("ติดตั้งใหม่ (Redeploy)")).toBeTruthy();
    expect(install.getByText("พร้อมใช้งาน (ready)").className).toContain("p-live");
    expect(install.getByText("owner-1")).toBeTruthy();
    expect(install.getByText("Owner")).toBeTruthy();
    expect(install.getByText("10:00")).toBeTruthy();
    // An audit change row shows its action code, no status badge, and the employee role.
    const config = within(row("cfg-1"));
    expect(config.getByText("แก้ค่าแบรนด์ (Config change)")).toBeTruthy();
    expect(config.getByText("brand.update").tagName).toBe("CODE");
    expect(config.queryByText("เสร็จแล้ว (done)")).toBeNull();
    expect(config.getByText("พนักงาน")).toBeTruthy();
    // An event row: type badge with its tone, the note, actor and role.
    const event = within(row("ads-e1"));
    expect(event.getByText("โฆษณาถูกปฏิเสธ (Ad disapproved)").className).toContain("p-bad");
    expect(event.getByText("โฆษณาหลักถูกปฏิเสธ")).toBeTruthy();
    expect(event.getByText("12:00")).toBeTruthy();
    expect(row("ads-e1").querySelector("time")!.getAttribute("datetime")).toBe(local(22, 12).toISOString());
  });

  it("an install row shows template and form versions from and to", async () => {
    await open();
    expect(within(row("inst-2")).getByText("template tpl-v1 → tpl-v2 · form form@aaa1111 → form@bbb2222")).toBeTruthy();
    // No revision refs, or refs that do not differ, add no line.
    expect(row("cfg-1").querySelector(".tl-versions")).toBeNull();
  });

  it("shows only the version part that differs", async () => {
    const same = installChange("inst-2", local(22, 10));
    same.to_revision = { ...same.from_revision!, revision: 2, bundle_form_version: "form@bbb2222" };
    respond = () => json(response({ items: [same, ITEMS[0]!] }));
    await open();
    expect(within(row("inst-2")).getByText("form form@aaa1111 → form@bbb2222")).toBeTruthy();
  });

  it("an event row shows the since-last-change line linking to the change row, and is highlighted within 24 h", async () => {
    await open();
    const near = within(row("ads-e1")).getByRole("link", { name: /หลังการเปลี่ยนแปลงล่าสุด 2 ชม\. \(2h\)/ });
    expect(near.getAttribute("href")).toBe("#tl-inst-2");
    expect(near.textContent).toBe("หลังการเปลี่ยนแปลงล่าสุด 2 ชม. (2h) (after the last change): ติดตั้ง/ย้อนกลับ (Deploy/Rollback) · ติดตั้งใหม่ (Redeploy)");
    expect(row("ads-e1").classList.contains("tl-near-change")).toBe(true);
    // 30 h after the config change: the line shows, the highlight does not.
    const far = within(row("ads-e2")).getByRole("link", { name: /หลังการเปลี่ยนแปลงล่าสุด 30 ชม\. \(30h\)/ });
    expect(far.getAttribute("href")).toBe("#tl-cfg-1");
    expect(row("ads-e2").classList.contains("tl-near-change")).toBe(false);
    // The anchor target exists.
    expect(document.querySelector(far.getAttribute("href")!)).toBe(row("cfg-1"));
    // Change rows carry no such line.
    expect(row("inst-2").querySelector(".tl-since")).toBeNull();
  });

  it("an event with no earlier change in the list shows no since line", async () => {
    respond = () => json(response({ items: [ITEMS[0]!] }));
    await open();
    expect(row("ads-e1").querySelector(".tl-since")).toBeNull();
    expect(row("ads-e1").classList.contains("tl-near-change")).toBe(false);
  });

  it("checking a type filter updates the URL and sends types in the request", async () => {
    await open();
    expect(lastCall().searchParams.has("types")).toBe(false);
    expect((screen.getByRole("checkbox", { name: "แก้ไขใน factory (Factory edit)" }) as HTMLInputElement).checked).toBe(true);
    const entries = window.history.length;
    fireEvent.click(screen.getByRole("checkbox", { name: "แก้ไขใน factory (Factory edit)" }));
    await waitFor(() => expect(timelineCalls()).toHaveLength(2));
    expect(window.location.pathname).toBe("/brands/b1/timeline");
    expect(new URLSearchParams(window.location.search).get("types")).toBe("config,pause_resume,deploy,ad_disapproved,account_suspended,account_reinstated,policy_warning,bot_visit_observed,other");
    expect(lastCall().searchParams.get("types")).toBe("config,pause_resume,deploy,ad_disapproved,account_suspended,account_reinstated,policy_warning,bot_visit_observed,other");
    expect(window.history.length).toBe(entries);
    expect((screen.getByRole("checkbox", { name: "แก้ไขใน factory (Factory edit)" }) as HTMLInputElement).checked).toBe(false);
    // Checking it again returns to the default URL.
    await screen.findByText("โฆษณาหลักถูกปฏิเสธ");
    fireEvent.click(screen.getByRole("checkbox", { name: "แก้ไขใน factory (Factory edit)" }));
    await waitFor(() => expect(timelineCalls()).toHaveLength(3));
    expect(window.location.search).toBe("");
    expect(lastCall().searchParams.has("types")).toBe(false);
  });

  it("the 7-day preset sends from and keeps the range in the URL", async () => {
    await open();
    // The default range is 30 days.
    expect(screen.getByRole("button", { name: "30 วัน" }).getAttribute("aria-pressed")).toBe("true");
    expect(Math.abs(Date.parse(lastCall().searchParams.get("from")!) - (Date.now() - 30 * 86_400_000))).toBeLessThan(60_000);
    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await waitFor(() => expect(timelineCalls()).toHaveLength(2));
    expect(Math.abs(Date.parse(lastCall().searchParams.get("from")!) - (Date.now() - 7 * 86_400_000))).toBeLessThan(60_000);
    expect(window.location.search).toBe("?range=7d");
    expect(screen.getByRole("button", { name: "7 วัน" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "ทั้งหมด (All)" }));
    await waitFor(() => expect(timelineCalls()).toHaveLength(3));
    expect(lastCall().searchParams.has("from")).toBe(false);
  });

  it("custom dates go to the request as local-day bounds and to the URL", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("ตั้งแต่ (From)"), { target: { value: "2026-07-20" } });
    await waitFor(() => expect(timelineCalls()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("ถึง (To)"), { target: { value: "2026-07-22" } });
    await waitFor(() => expect(timelineCalls()).toHaveLength(3));
    expect(window.location.search).toBe("?from=2026-07-20&to=2026-07-22");
    expect(lastCall().searchParams.get("from")).toBe(new Date(2026, 6, 20, 0, 0, 0, 0).toISOString());
    expect(lastCall().searchParams.get("to")).toBe(new Date(2026, 6, 22, 23, 59, 59, 999).toISOString());
    expect(screen.getByRole("button", { name: "30 วัน" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("reads the filters from the URL and resets them", async () => {
    window.history.replaceState(null, "", "/brands/b1/timeline?range=90d&types=deploy,other");
    await open();
    expect(Math.abs(Date.parse(lastCall().searchParams.get("from")!) - (Date.now() - 90 * 86_400_000))).toBeLessThan(60_000);
    expect(lastCall().searchParams.get("types")).toBe("deploy,other");
    expect(screen.getByRole("button", { name: "90 วัน" }).getAttribute("aria-pressed")).toBe("true");
    const checked = screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked).map((box) => box.closest("label")!.textContent);
    expect(checked).toEqual(["ติดตั้ง/ย้อนกลับ (Deploy/Rollback)", "อื่น ๆ (Other)"]);
    fireEvent.click(screen.getByRole("button", { name: "ล้างตัวกรอง (Reset filters)" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    await waitFor(() => expect(timelineCalls()).toHaveLength(2));
    expect(lastCall().searchParams.has("types")).toBe(false);
    expect(screen.getByRole("button", { name: "30 วัน" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "ล้างตัวกรอง (Reset filters)" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("follows Back to the filters of the earlier entry", async () => {
    window.history.replaceState(null, "", "/brands/b1/timeline?range=7d");
    await open();
    await act(async () => {
      window.history.pushState(null, "", "/brands/b1/timeline?range=90d");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "90 วัน" }).getAttribute("aria-pressed")).toBe("true"));
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "7 วัน" }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("unchecking every type shows the empty state without a request", async () => {
    window.history.replaceState(null, "", "/brands/b1/timeline?types=config");
    await open();
    expect(timelineCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "แก้ค่าแบรนด์ (Config change)" }));
    await screen.findByText("ไม่มีรายการในช่วงนี้ (Nothing in this range)");
    expect(window.location.search).toBe("?types=");
    expect(timelineCalls()).toHaveLength(1);
    expect(document.querySelector(".tl-row")).toBeNull();
    expect(screen.getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    // Checking one again asks for it.
    fireEvent.click(screen.getByRole("checkbox", { name: "อื่น ๆ (Other)" }));
    await waitFor(() => expect(timelineCalls()).toHaveLength(2));
    expect(lastCall().searchParams.get("types")).toBe("other");
  });

  it("a From day after the To day asks for nothing", async () => {
    window.history.replaceState(null, "", "/brands/b1/timeline?from=2026-07-22&to=2026-07-20");
    render(<BrandTimelineScreen me={owner} brandId="b1" />);
    await screen.findByText("วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด (From must not be after To)");
    expect(timelineCalls()).toHaveLength(0);
  });

  it("ignores a late answer for old filters", async () => {
    const held: Array<(r: Response) => void> = [];
    respond = (url) => {
      if (url.searchParams.has("types")) return json(response({ items: [adsEvent("only", local(22, 8), "other", "ของใหม่")] }));
      return new Promise<Response>((resolve) => held.push(resolve));
    };
    render(<BrandTimelineScreen me={owner} brandId="b1" />);
    await waitFor(() => expect(timelineCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole("checkbox", { name: "แก้ไขใน factory (Factory edit)" }));
    await screen.findByText("ของใหม่");
    // Answer the first request late and wait until the screen has read its body, so the assertions below
    // run after the stale answer has reached the `.then` that the `active` guard protects.
    const stale = json(response());
    let consumed = false;
    const readBody = stale.json.bind(stale);
    stale.json = async () => { const body = await readBody(); consumed = true; return body; };
    await act(async () => {
      held[0]!(stale);
      for (let i = 0; i < 50 && !consumed; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(consumed).toBe(true);
    expect(screen.getByText("ของใหม่")).toBeTruthy();
    expect(screen.queryByText("โฆษณาหลักถูกปฏิเสธ")).toBeNull();
    expect(rowIds()).toEqual(["tl-ads-only"]);
  });

  it("shows the core_audit note, the has_more note and the own-scope hint for an employee", async () => {
    await open(employee);
    expect(screen.queryByText(/ไทม์ไลน์ไม่ครบ/)).toBeNull();
    expect(screen.queryByText(/แสดง 4 รายการล่าสุด/)).toBeNull();
    expect(screen.queryByText(/คุณเห็นเฉพาะการแก้ไขที่คุณทำเอง/)).toBeNull();
    cleanup();
    respond = () => json(response({ unavailable: ["core_audit"], has_more: true, actor_scope: "own" }));
    await open(employee);
    expect(screen.getByText("ไทม์ไลน์ไม่ครบ: อ่านประวัติจาก Core ไม่ได้ (core_audit) การแก้ไขค่าของแบรนด์ที่ Core บันทึกอยู่อาจหายไป (Part of the timeline is missing: the core audit source is unavailable.)")).toBeTruthy();
    expect(screen.getByText("แสดง 4 รายการล่าสุด ให้แคบช่วงวันที่เพื่อดูรายการเก่ากว่า (Showing the newest 4; narrow the date range to see older items)")).toBeTruthy();
    expect(screen.getByText("คุณเห็นเฉพาะการแก้ไขที่คุณทำเอง การติดตั้งและเหตุการณ์ Ads แสดงครบ (You see only your own edits; deploys and Ads events are complete)")).toBeTruthy();
  });

  it("shows an empty state for a range without items", async () => {
    respond = () => json(response({ items: [] }));
    render(<BrandTimelineScreen me={owner} brandId="b1" />);
    await screen.findByText("ไม่มีรายการในช่วงนี้ (Nothing in this range)");
    expect(document.querySelector(".tl-row")).toBeNull();
  });

  it("a failed load shows Retry and a retry reloads", async () => {
    let calls = 0;
    respond = () => (++calls === 1 ? json({ error: "bad_gateway" }, 502) : json(response()));
    render(<BrandTimelineScreen me={owner} brandId="b1" />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("เกิดข้อผิดพลาด (502)")).toBeTruthy();
    expect(document.querySelector(".tl-row")).toBeNull();
    // The filter bar stays usable while the list failed.
    expect(screen.getByRole("button", { name: "7 วัน" })).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "ลองใหม่ (Retry)" }));
    await screen.findByText("โฆษณาหลักถูกปฏิเสธ");
    expect(timelineCalls()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a 404 shows Brand not found", async () => {
    respond = () => json({ error: "not_found", resource: "brand" }, 404);
    render(<BrandTimelineScreen me={owner} brandId="b1" />);
    await screen.findByText("ไม่พบแบรนด์ (Brand not found)");
    expect(screen.queryByRole("button", { name: "30 วัน" })).toBeNull();
  });

  it("keeps the filter bar wrapping and long text breaking so 375 px has no sideways scroll", () => {
    const css = readFileSync(resolve(process.cwd(), "src/client/screens/BrandTimeline.css"), "utf8");
    expect(css).toMatch(/\.tl-filter-row \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.tl-presets \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.tl-types \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.tl-body \{[^}]*min-width: 0/);
    // Each cell that holds operator or server text: note, action code, version ids, type labels, actor id, since link, role/status badges.
    for (const cls of ["tl-note", "tl-what", "tl-versions", "tl-category", "tl-actor", "tl-since a", "tl-body .pill"]) {
      const escaped = cls.replace(/[.\s]/g, (c) => (c === "." ? "\\." : "\\s+"));
      expect(css, cls).toMatch(new RegExp(`\\.${escaped}[^{]*\\{[^}]*overflow-wrap: anywhere`));
    }
    expect(css).toMatch(/\.tl-body \.pill \{[^}]*white-space: normal/);
  });
});
