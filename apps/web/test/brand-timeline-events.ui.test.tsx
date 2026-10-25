import type { DeployEvent } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { BrandTimelineScreen } from "../src/client/screens/BrandTimeline";
import type { TimelineItem, TimelineResponse } from "../src/shared/timeline";

const owner: Me = { id: "owner", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "employee", email: "employee@example.test", role: "employee" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Local dates in July, so the clock times hold in any time zone and no DST change falls inside.
const local = (day: number, h: number, min = 0): Date => new Date(2026, 6, day, h, min);

const change = (id: string, at: Date): Extract<TimelineItem, { kind: "change" }> => ({
  kind: "change", item_id: id, at: at.toISOString(), category: "config",
  change: {
    source: "audit", event_id: id, brand_id: "b1", operation: null, action: "brand.update", status: "done",
    from_revision_id: null, to_revision_id: null, is_canary: false, started_by: "employee-1", started_role: "employee",
    started_at: at.toISOString(), finished_at: null, error: null,
  } satisfies DeployEvent,
  from_revision: null, to_revision: null,
});

const adsEvent = (id: string, at: Date, type: Extract<TimelineItem, { kind: "ads_event" }>["event"]["type"], note: string): Extract<TimelineItem, { kind: "ads_event" }> => ({
  kind: "ads_event", item_id: `ads-${id}`, at: at.toISOString(),
  event: { event_id: id, brand_id: "b1", type, occurred_at: at.toISOString(), note, created_by: "owner-1", created_role: "owner", created_at: at.toISOString() },
});

const E1 = adsEvent("e1", local(22, 12), "ad_disapproved", "โฆษณาหลักถูกปฏิเสธ");
const E2 = adsEvent("e2", local(21, 15), "account_suspended", "บัญชีถูกระงับ");
const C1 = change("cfg-1", local(20, 9));

const response = (items: TimelineItem[]): TimelineResponse => ({ brand_id: "b1", items, has_more: false, unavailable: [], actor_scope: "all" });

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let items: TimelineItem[];
let handle: (call: Call) => Response | Promise<Response> | undefined;
const timelineCalls = () => calls.filter((c) => c.method === "GET" && c.path === "/api/brands/b1/timeline");
const writes = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/api/brands/b1/ads-events"));

beforeEach(() => {
  window.history.replaceState(null, "", "/brands/b1/timeline");
  calls = [];
  items = [E1, E2, C1];
  handle = () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.origin);
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const custom = handle(call);
    if (custom) return custom;
    if (call.path === "/api/brands/b1/timeline") return json(response(items));
    if (call.path === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "b1", hostnames: ["shop.example"] }] });
    if (call.path === "/api/brands") return json({ brands: [], generated_at: "2026-07-22T00:00:00.000Z" });
    throw new Error(`Unexpected test HTTP request: ${call.method} ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const open = async (me: Me = owner) => {
  render(<BrandTimelineScreen me={me} brandId="b1" />);
  await screen.findByText("โฆษณาหลักถูกปฏิเสธ");
};
const form = () => within(screen.getByRole("region", { name: "บันทึกเหตุการณ์ (Add event)" }));
const typeSelect = () => form().getByRole("combobox", { name: "ประเภท (Type)" }) as unknown as HTMLSelectElement;
const timeInput = () => form().getByLabelText<HTMLInputElement>("เวลาที่เกิดเหตุ (Time)");
const noteBox = () => form().getByRole<HTMLTextAreaElement>("textbox", { name: "หมายเหตุ (Note)" });
const submitButton = () => form().getByRole<HTMLButtonElement>("button", { name: "บันทึก (Save)" });
const row = (id: string) => document.getElementById(`tl-${id}`)!;

describe("brand timeline: add event", () => {
  it("the time input defaults to now and the POST body carries the chosen type, ISO time and note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(22, 14, 5));
    await open(employee);
    expect(timeInput().value).toBe("2026-07-22T14:05");
    expect(timeInput().type).toBe("datetime-local");
    // The six D2 labels, in order.
    expect([...typeSelect().options].map((o) => o.text)).toEqual([
      "โฆษณาถูกปฏิเสธ (Ad disapproved)", "บัญชีถูกระงับ (Account suspended)", "บัญชีกลับมาใช้ได้ (Account reinstated)",
      "คำเตือนนโยบาย (Policy warning)", "พบการเข้าชมของบอท (Bot visit observed)", "อื่น ๆ (Other)",
    ]);
    expect(form().getByText("0/500")).toBeTruthy();

    fireEvent.change(typeSelect(), { target: { value: "policy_warning" } });
    fireEvent.change(timeInput(), { target: { value: "2026-07-22T13:30" } });
    const typed = "  เตือนเรื่องเนื้อหา  ";
    fireEvent.change(noteBox(), { target: { value: typed } });
    expect(form().getByText(`${typed.length}/500`)).toBeTruthy();
    fireEvent.click(submitButton());

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: "POST",
      path: "/api/brands/b1/ads-events",
      body: { type: "policy_warning", occurred_at: local(22, 13, 30).toISOString(), note: "เตือนเรื่องเนื้อหา" },
    });
  });

  it("success shows the toast, resets the form and reloads the list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(22, 14, 5));
    await open();
    const created = adsEvent("e3", local(22, 13, 30), "account_reinstated", "กลับมาแล้ว");
    handle = (call) => {
      if (call.method === "POST") {
        items = [created, ...items];
        return json({ event: created.event }, 201);
      }
      return undefined;
    };
    fireEvent.change(typeSelect(), { target: { value: "account_reinstated" } });
    fireEvent.change(timeInput(), { target: { value: "2026-07-22T13:30" } });
    fireEvent.change(noteBox(), { target: { value: "กลับมาแล้ว" } });
    vi.setSystemTime(local(22, 14, 20));
    fireEvent.click(submitButton());

    expect(await screen.findByText("บันทึกเหตุการณ์แล้ว (Event saved)")).toBeTruthy();
    await waitFor(() => expect(row("ads-e3")).toBeTruthy());
    expect(timelineCalls()).toHaveLength(2);
    // Reset: first type, the new now, empty note.
    expect(typeSelect().value).toBe("ad_disapproved");
    expect(timeInput().value).toBe("2026-07-22T14:20");
    expect(noteBox().value).toBe("");
    expect(submitButton().disabled).toBe(false);
  });

  it("a 422 shows the issue under the time field", async () => {
    await open();
    handle = (call) => call.method === "POST"
      ? json({ error: "invalid", issues: [{ path: "occurred_at", message: "occurred_at must not be more than 5 minutes in the future" }] }, 422)
      : undefined;
    fireEvent.click(submitButton());
    const message = await screen.findByText("occurred_at must not be more than 5 minutes in the future");
    const time = timeInput();
    expect(time.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(time.getAttribute("aria-describedby")!)!.contains(message)).toBe(true);
    // The other fields show nothing, no toast, and the typed values stay.
    expect(noteBox().getAttribute("aria-describedby")).toBeNull();
    expect(typeSelect().getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(timeInput().value).not.toBe("");
    expect(submitButton().disabled).toBe(false);
  });

  it("a 422 puts type and note issues under their own fields", async () => {
    await open();
    handle = (call) => call.method === "POST"
      ? json({ error: "invalid", issues: [{ path: "type", message: "bad type" }, { path: "note", message: "note is required when type is other" }] }, 422)
      : undefined;
    fireEvent.click(submitButton());
    const typeMessage = await screen.findByText("bad type");
    const noteMessage = screen.getByText("note is required when type is other");
    expect(document.getElementById(typeSelect().getAttribute("aria-describedby")!)!.contains(typeMessage)).toBe(true);
    expect(document.getElementById(noteBox().getAttribute("aria-describedby")!)!.contains(noteMessage)).toBe(true);
    expect(timeInput().getAttribute("aria-describedby")).toBeNull();
  });

  it("another error shows ApiError.thai in an error toast and keeps the form", async () => {
    await open();
    handle = (call) => call.method === "POST" ? json({ error: "bad_gateway" }, 502) : undefined;
    fireEvent.change(noteBox(), { target: { value: "x" } });
    fireEvent.click(submitButton());
    const toast = await screen.findByRole("alert");
    expect(toast.textContent).toContain("เกิดข้อผิดพลาด (502)");
    expect(noteBox().value).toBe("x");
    expect(timelineCalls()).toHaveLength(1);
  });

  it("Other with an empty note disables submit", async () => {
    await open();
    const message = "ต้องใส่หมายเหตุสำหรับประเภทอื่น ๆ (A note is required for Other)";
    expect(screen.queryByText(message)).toBeNull();
    expect(submitButton().disabled).toBe(false);
    fireEvent.change(typeSelect(), { target: { value: "other" } });
    expect(screen.getByText(message)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    // Spaces alone are still empty.
    fireEvent.change(noteBox(), { target: { value: "   " } });
    expect(submitButton().disabled).toBe(true);
    fireEvent.submit(submitButton().closest("form")!);
    expect(writes()).toHaveLength(0);
    fireEvent.change(noteBox(), { target: { value: "ดูผิดปกติ" } });
    expect(screen.queryByText(message)).toBeNull();
    expect(submitButton().disabled).toBe(false);
  });

  it("disables submit while in flight and sends one request", async () => {
    await open();
    let release!: (r: Response) => void;
    handle = (call) => call.method === "POST" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined;
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    fireEvent.submit(submitButton().closest("form")!);
    expect(writes()).toHaveLength(1);
    release(json({ event: E1.event }, 201));
    await waitFor(() => expect(submitButton().disabled).toBe(false));
  });
});

describe("brand timeline: delete", () => {
  it("an employee sees no Delete button", async () => {
    await open(employee);
    expect(screen.queryByRole("button", { name: "ลบ (Delete)" })).toBeNull();
    // The form is still there.
    expect(submitButton()).toBeTruthy();
  });

  it("an owner sees Delete on event rows only", async () => {
    await open(owner);
    expect(screen.getAllByRole("button", { name: "ลบ (Delete)" })).toHaveLength(2);
    expect(within(row("ads-e1")).getByRole("button", { name: "ลบ (Delete)" })).toBeTruthy();
    expect(within(row("ads-e2")).getByRole("button", { name: "ลบ (Delete)" })).toBeTruthy();
    expect(within(row("cfg-1")).queryByRole("button", { name: "ลบ (Delete)" })).toBeNull();
  });

  it("an owner deletes after confirming; Cancel sends no request", async () => {
    await open(owner);
    fireEvent.click(within(row("ads-e1")).getByRole("button", { name: "ลบ (Delete)" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("ลบเหตุการณ์นี้? (Delete this event?)")).toBeTruthy();
    expect(dialog.textContent).toContain("โฆษณาถูกปฏิเสธ (Ad disapproved)");
    expect(dialog.textContent).toContain("12:00");
    expect(within(dialog).getByRole("button", { name: "ลบ (Delete)" }).className).toContain("danger");

    fireEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก (Cancel)" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(writes()).toHaveLength(0);
    expect(timelineCalls()).toHaveLength(1);

    handle = (call) => {
      if (call.method === "DELETE") {
        items = items.filter((i) => i.item_id !== "ads-e1");
        return json({ deleted: E1.event });
      }
      return undefined;
    };
    fireEvent.click(within(row("ads-e1")).getByRole("button", { name: "ลบ (Delete)" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ลบ (Delete)" }));

    expect(await screen.findByText("ลบแล้ว (Deleted)")).toBeTruthy();
    expect(writes()).toEqual([{ method: "DELETE", path: "/api/brands/b1/ads-events/e1", body: undefined }]);
    await waitFor(() => expect(document.getElementById("tl-ads-e1")).toBeNull());
    expect(timelineCalls()).toHaveLength(2);
    expect(row("ads-e2")).toBeTruthy();
  });

  it("a failed delete shows ApiError.thai in an error toast and keeps the row", async () => {
    await open(owner);
    handle = (call) => call.method === "DELETE" ? json({ error: "bad_gateway" }, 502) : undefined;
    fireEvent.click(within(row("ads-e2")).getByRole("button", { name: "ลบ (Delete)" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ลบ (Delete)" }));
    const toast = await screen.findByRole("alert");
    expect(toast.textContent).toContain("เกิดข้อผิดพลาด (502)");
    expect(row("ads-e2")).toBeTruthy();
    expect(timelineCalls()).toHaveLength(1);
    expect(within(row("ads-e2")).getByRole("button", { name: "ลบ (Delete)" }).hasAttribute("disabled")).toBe(false);
  });
});
