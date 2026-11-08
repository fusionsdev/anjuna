import conversionsFixture from "@anjuna/contracts/fixtures/admin/conversions.response.json";
import type { ConversionsReportResponse } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { navigate } from "../src/client/router";
import { ConversionsScreen, conversionsPath, readConversionFilters } from "../src/client/screens/Conversions";

const report = conversionsFixture as ConversionsReportResponse;
const owner: Me = { id: "owner", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "employee", email: "employee@example.test", role: "employee" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const table = () => screen.findByRole("table", { name: "รายการคอนเวอร์ชัน (Conversions)" });
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
const back = () => act(async () => {
  window.history.back();
  await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
});
const forward = () => act(async () => {
  window.history.forward();
  await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
});

// What core returns to an employee: no money, and no free-text error that is not on the allow-list.
const redacted: ConversionsReportResponse = {
  ...report,
  value_totals: null,
  rows: report.rows.map((row) => ({ ...row, value: null, last_error: null })),
};

let requests: URL[];
let respond: (url: URL) => Response | Promise<Response>;
const conversionCalls = () => requests.filter((url) => url.pathname === "/api/conversions");
const lastCall = () => conversionCalls().at(-1)!;

beforeEach(() => {
  window.history.replaceState(null, "", "/conversions");
  requests = [];
  respond = () => json(report);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, window.location.origin);
    requests.push(url);
    if (url.pathname === "/api/conversions") return respond(url);
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "brand-a", hostnames: ["a.example"] }] });
    if (url.pathname === "/api/brands") return json({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Conversions page", () => {
  it("reads period and status from the URL and asks core for them", async () => {
    window.history.replaceState(null, "", "/conversions?period=30d&status=dead");
    render(<ConversionsScreen me={owner} />);
    await table();
    expect(conversionCalls()).toHaveLength(1);
    expect(lastCall().searchParams.get("period")).toBe("30d");
    expect(lastCall().searchParams.get("status")).toBe("dead");
    expect(lastCall().searchParams.has("brand")).toBe(false);
    expect(pressed("30 วัน")).toBe("true");
    expect(pressed("7 วัน")).toBe("false");
    expect(pressed("วันนี้")).toBe("false");
    expect(pressed("ส่งไม่ได้ (dead)")).toBe("true");
    expect(pressed("ทั้งหมด")).toBe("false");
  });

  it("shows the เมื่อวาน chip and asks core for yesterday when it is pressed", async () => {
    render(<ConversionsScreen me={owner} />);
    await table();
    expect(pressed("เมื่อวาน")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "เมื่อวาน" }));
    await waitFor(() => expect(lastCall().searchParams.get("period")).toBe("yesterday"));
    expect(pressed("เมื่อวาน")).toBe("true");
    expect(window.location.search).toContain("period=yesterday");
  });

  it("reads period=yesterday from the URL", async () => {
    window.history.replaceState(null, "", "/conversions?period=yesterday");
    render(<ConversionsScreen me={owner} />);
    await table();
    expect(lastCall().searchParams.get("period")).toBe("yesterday");
    expect(pressed("เมื่อวาน")).toBe("true");
  });

  it("falls back to 7d and all for unknown query values", async () => {
    window.history.replaceState(null, "", "/conversions?period=bogus&status=x");
    render(<ConversionsScreen me={owner} />);
    await table();
    expect(conversionCalls()).toHaveLength(1);
    expect(lastCall().searchParams.get("period")).toBe("7d");
    expect(lastCall().searchParams.has("status")).toBe(false);
    expect(pressed("7 วัน")).toBe("true");
    expect(pressed("ทั้งหมด")).toBe("true");
    expect(pressed("ส่งไม่ได้ (dead)")).toBe("false");
  });

  it("writes the status chip into the URL with replace", async () => {
    render(<ConversionsScreen me={owner} />);
    await table();
    const entries = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "ส่งไม่ได้ (dead)" }));
    expect(window.location.pathname).toBe("/conversions");
    expect(new URLSearchParams(window.location.search).get("status")).toBe("dead");
    expect(window.history.length).toBe(entries);
    await waitFor(() => expect(lastCall().searchParams.get("status")).toBe("dead"));
    expect(pressed("ส่งไม่ได้ (dead)")).toBe("true");
    expect(pressed("ทั้งหมด")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    expect(new URLSearchParams(window.location.search).get("period")).toBe("30d");
    expect(new URLSearchParams(window.location.search).get("status")).toBe("dead");
    expect(window.history.length).toBe(entries);
    await waitFor(() => expect(lastCall().searchParams.get("period")).toBe("30d"));

    // The default chip leaves the URL clean again.
    fireEvent.click(screen.getByRole("button", { name: "ทั้งหมด" }));
    expect(new URLSearchParams(window.location.search).has("status")).toBe(false);
    expect(window.history.length).toBe(entries);
    await waitFor(() => expect(lastCall().searchParams.has("status")).toBe(false));
    expect(lastCall().searchParams.get("period")).toBe("30d");
  });

  it("shows the reason label, fix text and full error", async () => {
    render(<ConversionsScreen me={owner} />);
    await table();
    // One row per reason code in the fixture. Label and fix text are the spec "UI text per code" table.
    const expected: Array<[string, string]> = [
      ["ไม่มี click id (No click id)", "Lead มาโดยไม่มี gclid/gbraid/wbraid/msclkid. ส่งขึ้น Ads ไม่ได้. ตรวจว่าแคมเปญเปิด auto-tagging."],
      ["ลองครบแล้ว (Attempts exhausted)", "Drain ดึงไปแล้วไม่ตอบกลับจนครบจำนวนครั้ง. ตรวจ log ของ drain บน VPS."],
      ["ไม่มี route (No route)", "Drain ไม่รู้ว่าแบรนด์นี้ส่งเข้าบัญชี Ads ไหน. เพิ่ม route ใน drain config บน VPS."],
      ["ยังไม่พร้อม (Not ready)", "Ads ยังไม่รับ click นี้. Drain จะลองใหม่เอง."],
      ["ตั้งค่า Microsoft ไม่ครบ (Microsoft env missing)", "ตั้ง ACCOUNT และ CONVERSION_NAME ของ Microsoft Ads ใน env ของ drain."],
      ["อัปโหลดไม่ผ่าน (Upload failed)", "Ads ตอบ error. Drain จะลองใหม่ตาม backoff."],
      ["Ads ตอบ error (Platform error)", "ดูข้อความ error เต็มในแถว."],
    ];
    for (const [label, fix] of expected) {
      const row = screen.getByText(label).closest("tr")!;
      expect(within(row).getByText(fix)).toBeTruthy();
    }
    const noRoute = screen.getByText("ไม่มี route (No route)").closest("tr")!;
    const details = noRoute.querySelector("details")!;
    expect(within(details).getByText("ข้อความเต็ม")).toBeTruthy();
    expect(details.textContent).toContain("no route for brand=brand-a hostname=a.example");
    const platform = screen.getByText("Ads ตอบ error (Platform error)").closest("tr")!;
    expect(platform.querySelector("details")!.textContent).toContain("INVALID_GCLID: The gclid could not be decoded");
    // The uploaded and processing rows have no reason and no error text.
    expect(document.querySelectorAll("details")).toHaveLength(7);
    expect(screen.getAllByRole("row")).toHaveLength(1 + report.rows.length);
  });

  it("shows the value column and value totals to the owner only", async () => {
    const view = render(<ConversionsScreen me={owner} />);
    await table();
    expect(screen.getAllByRole("columnheader")).toHaveLength(8);
    expect(screen.getByRole("columnheader", { name: "มูลค่า (Value)" })).toBeTruthy();
    expect(screen.getByText("$412.50")).toBeTruthy();
    expect(screen.getByText("$170.00")).toBeTruthy();
    expect(screen.getByText("มูลค่าที่ส่งแล้ว")).toBeTruthy();
    expect(screen.getByText("มูลค่าที่ส่งไม่ได้")).toBeTruthy();
    expect(screen.getByText("$85.00")).toBeTruthy();
    view.unmount();

    // The response still carries every number: the role check alone hides them.
    render(<ConversionsScreen me={employee} />);
    await table();
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
    expect(screen.queryByRole("columnheader", { name: "มูลค่า (Value)" })).toBeNull();
    expect(screen.queryByText("มูลค่าที่ส่งแล้ว")).toBeNull();
    expect(screen.queryByText("มูลค่าที่ส่งไม่ได้")).toBeNull();
    expect(screen.queryByText("$412.50")).toBeNull();
    expect(document.body.textContent).not.toContain("$");
  });

  it("shows the empty state and the truncated note", async () => {
    respond = () => json({ ...report, rows: [], truncated: false, stalled: 0 });
    const view = render(<ConversionsScreen me={owner} />);
    expect(await screen.findByText("ยังไม่มีคอนเวอร์ชันในช่วงนี้")).toBeTruthy();
    expect(screen.queryByText("แสดง 200 แถวล่าสุด")).toBeNull();
    expect(screen.queryByText(/ค้างเกิน 6 ชม\./)).toBeNull();
    view.unmount();

    respond = () => json({ ...report, truncated: true });
    render(<ConversionsScreen me={owner} />);
    expect(await screen.findByRole("button", { name: "โหลดเพิ่ม (Load more)" })).toBeTruthy();
    expect(screen.queryByText("แสดง 200 แถวล่าสุด")).toBeNull();
    expect(screen.queryByText("ยังไม่มีคอนเวอร์ชันในช่วงนี้")).toBeNull();
  });

  it("shows ApiError.thai on failure", async () => {
    respond = () => json({ error: "internal" }, 500);
    const view = render(<ConversionsScreen me={owner} />);
    expect((await screen.findByRole("alert")).textContent).toBe("เกิดข้อผิดพลาด (500)");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("ยังไม่มีคอนเวอร์ชันในช่วงนี้")).toBeNull();
    view.unmount();

    respond = () => json({ error: "unauthorized" }, 401);
    render(<ConversionsScreen me={owner} />);
    expect((await screen.findByRole("alert")).textContent).toBe("เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง");
  });
});

describe("Conversions page: details", () => {
  it("shows the summary counts, and the stalled badge only above 0", async () => {
    render(<ConversionsScreen me={owner} />);
    await table();
    const ledger = screen.getByRole("group", { name: "สรุปคอนเวอร์ชัน" });
    const count = (label: string) => within(ledger).getByText(label).nextElementSibling?.textContent;
    expect(count("ค้างส่ง")).toBe("3");
    expect(count("กำลังส่ง")).toBe("1");
    expect(count("ส่งแล้ว")).toBe("5");
    expect(count("ส่งไม่ได้")).toBe("4");
    expect(within(ledger).getByText("ค้างเกิน 6 ชม. 1").className).toContain("p-warn");
  });

  it("maps each status to its badge tone", async () => {
    render(<ConversionsScreen me={owner} />);
    const grid = await table();
    const tone = (label: string) => within(grid).getAllByText(label)[0]!.className;
    expect(tone("ส่งแล้ว")).toContain("p-live");
    expect(tone("ค้างส่ง")).toContain("p-blue");
    expect(tone("กำลังส่ง")).toContain("p-mute");
    expect(tone("ส่งไม่ได้")).toContain("p-bad");
  });

  it("keeps the reason label and fix text but no full-text block when last_error is null or empty", async () => {
    const rows = redacted.rows.map((row, i) => (i === 3 ? { ...row, last_error: "" } : row));
    respond = () => json({ ...redacted, rows });
    render(<ConversionsScreen me={employee} />);
    await table();
    expect(screen.getByText("ไม่มี route (No route)")).toBeTruthy();
    expect(screen.getByText("Drain ไม่รู้ว่าแบรนด์นี้ส่งเข้าบัญชี Ads ไหน. เพิ่ม route ใน drain config บน VPS.")).toBeTruthy();
    expect(screen.getByText("Ads ตอบ error (Platform error)")).toBeTruthy();
    expect(document.querySelectorAll("details")).toHaveLength(0);
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
    expect(document.body.textContent).not.toContain("$");
  });

  it("re-reads the filters on Back and Forward", async () => {
    window.history.replaceState(null, "", "/conversions?period=30d&status=dead");
    render(<ConversionsScreen me={owner} />);
    await table();
    expect(conversionCalls()).toHaveLength(1);
    // A push, as a link elsewhere in the panel makes it. The route stays /conversions.
    act(() => navigate("/conversions?status=pending"));
    await waitFor(() => expect(lastCall().searchParams.get("status")).toBe("pending"));
    expect(lastCall().searchParams.get("period")).toBe("7d");
    expect(pressed("7 วัน")).toBe("true");
    expect(pressed("ค้างส่ง (pending)")).toBe("true");

    await back();
    await waitFor(() => expect(lastCall().searchParams.get("status")).toBe("dead"));
    expect(lastCall().searchParams.get("period")).toBe("30d");
    expect(pressed("30 วัน")).toBe("true");
    expect(pressed("ส่งไม่ได้ (dead)")).toBe("true");
    expect(pressed("ค้างส่ง (pending)")).toBe("false");

    await forward();
    await waitFor(() => expect(lastCall().searchParams.get("status")).toBe("pending"));
    expect(lastCall().searchParams.get("period")).toBe("7d");
    expect(pressed("7 วัน")).toBe("true");
    expect(pressed("ค้างส่ง (pending)")).toBe("true");
  });

  it("drops a late response for old filters", async () => {
    const waiting: Array<(response: Response) => void> = [];
    respond = () => new Promise<Response>((resolve) => { waiting.push(resolve); });
    render(<ConversionsScreen me={owner} />);
    await waitFor(() => expect(conversionCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "ส่งไม่ได้ (dead)" }));
    await waitFor(() => expect(conversionCalls()).toHaveLength(2));

    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    waiting[1]!(json({ ...report, rows: report.rows.filter((row) => row.status === "dead") }));
    await table();
    expect(screen.getAllByRole("row")).toHaveLength(1 + 4);

    // The answer for status=all arrives last and must not replace the dead-only rows.
    waiting[0]!(json(report));
    await settle();
    expect(screen.getAllByRole("row")).toHaveLength(1 + 4);
    expect(screen.queryByText("ไม่มี route (No route)")).toBeNull();
    expect(screen.getByText("ลองครบแล้ว (Attempts exhausted)")).toBeTruthy();
  });

  it("sends a brand the labels do not know as given and writes the brand select into the URL", async () => {
    window.history.replaceState(null, "", "/conversions?brand=brand-ghost");
    render(<ConversionsScreen me={owner} />);
    await table();
    expect(lastCall().searchParams.get("brand")).toBe("brand-ghost");
    const select = screen.getByRole("combobox", { name: "แบรนด์" }) as unknown as HTMLSelectElement;
    expect(select.value).toBe("brand-ghost");
    const known = await screen.findByRole("option", { name: "a.example (brand-a)" });

    fireEvent.change(select, { target: { value: known.getAttribute("value") } });
    expect(new URLSearchParams(window.location.search).get("brand")).toBe("brand-a");
    await waitFor(() => expect(lastCall().searchParams.get("brand")).toBe("brand-a"));
    expect(select.value).toBe("brand-a");

    fireEvent.change(select, { target: { value: "" } });
    expect(new URLSearchParams(window.location.search).has("brand")).toBe(false);
    await waitFor(() => expect(lastCall().searchParams.has("brand")).toBe(false));
  });

  it("ignores a malformed brand in the URL instead of sending a request core answers with 422", async () => {
    window.history.replaceState(null, "", "/conversions?brand=Bad%20Brand!");
    render(<ConversionsScreen me={owner} />);
    await table();
    expect(lastCall().searchParams.has("brand")).toBe(false);
    expect((screen.getByRole("combobox", { name: "แบรนด์" }) as unknown as HTMLSelectElement).value).toBe("");
  });
});

describe("Conversions page: load more", () => {
  it("Load more re-fetches conversions with limit 400", async () => {
    respond = () => json({ ...report, truncated: true });
    render(<ConversionsScreen me={owner} />);
    await table();
    expect(lastCall().searchParams.get("limit")).toBe("200");
    fireEvent.click(await screen.findByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(lastCall().searchParams.get("limit")).toBe("400"));
    expect(conversionCalls()).toHaveLength(2);
    // The table stays on screen while the next page loads.
    expect(screen.getByRole("table", { name: "รายการคอนเวอร์ชัน (Conversions)" })).toBeTruthy();
  });

  it("a period change resets the conversions limit to 200", async () => {
    respond = () => json({ ...report, truncated: true });
    render(<ConversionsScreen me={owner} />);
    await table();
    fireEvent.click(await screen.findByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(lastCall().searchParams.get("limit")).toBe("400"));
    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await waitFor(() => expect(lastCall().searchParams.get("period")).toBe("30d"));
    expect(lastCall().searchParams.get("limit")).toBe("200");
  });

  it("Load more keeps the table and shows กำลังโหลด… while the next page loads", async () => {
    let release: ((response: Response) => void) | undefined;
    respond = (url) => url.searchParams.get("limit") === "400"
      ? new Promise<Response>((resolve) => { release = resolve; })
      : json({ ...report, truncated: true });
    render(<ConversionsScreen me={owner} />);
    await table();
    const rows = screen.getAllByRole("row").length;
    fireEvent.click(await screen.findByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(lastCall().searchParams.get("limit")).toBe("400"));
    const loading = await screen.findByRole("button", { name: "กำลังโหลด…" });
    expect((loading as HTMLButtonElement).disabled).toBe(true);
    // The table stays on screen while the next page loads.
    expect(screen.getByRole("table", { name: "รายการคอนเวอร์ชัน (Conversions)" })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(rows);
    await act(async () => { release!(json({ ...report, truncated: false })); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "กำลังโหลด…" })).toBeNull());
    expect(screen.getByRole("table", { name: "รายการคอนเวอร์ชัน (Conversions)" })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(rows);
  });

  it("the max note waits for the max page to load", async () => {
    let release: ((response: Response) => void) | undefined;
    respond = (url) => url.searchParams.get("limit") === "1000"
      ? new Promise<Response>((resolve) => { release = resolve; })
      : json({ ...report, truncated: true });
    render(<ConversionsScreen me={owner} />);
    for (const limit of ["400", "600", "800"]) {
      fireEvent.click(await screen.findByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
      await waitFor(() => expect(lastCall().searchParams.get("limit")).toBe(limit));
    }
    fireEvent.click(await screen.findByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(lastCall().searchParams.get("limit")).toBe("1000"));
    expect(await screen.findByRole("button", { name: "กำลังโหลด…" })).toBeTruthy();
    // The max note waits for the max page: no max note while it loads.
    expect(screen.queryByText(/ซึ่งเป็นจำนวนสูงสุด/)).toBeNull();
    expect(screen.getByRole("table", { name: "รายการคอนเวอร์ชัน (Conversions)" })).toBeTruthy();
    await act(async () => { release!(json({ ...report, truncated: true })); });
    expect(await screen.findByText(`แสดง ${report.rows.length} รายการ ซึ่งเป็นจำนวนสูงสุด กรุณากรองให้แคบลง (Narrow the filters)`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "โหลดเพิ่ม (Load more)" })).toBeNull();
  }, 20000);

  it("a failed Load more keeps the rows, shows the error and a retry works", async () => {
    let fail = true;
    respond = (url) => url.searchParams.get("limit") === "400" && fail
      ? json({ error: "internal" }, 500)
      : json({ ...report, truncated: true });
    render(<ConversionsScreen me={owner} />);
    await table();
    const rows = screen.getAllByRole("row").length;
    fireEvent.click(await screen.findByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("เกิดข้อผิดพลาด (500)");
    // The rows stay, the button stays, and the limit falls back with no extra request so a retry works.
    expect(screen.getByRole("table", { name: "รายการคอนเวอร์ชัน (Conversions)" })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(rows);
    expect(conversionCalls().map((url) => url.searchParams.get("limit"))).toEqual(["200", "400"]);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(lastCall().searchParams.get("limit")).toBe("400"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(conversionCalls().map((url) => url.searchParams.get("limit"))).toEqual(["200", "400", "400"]);
  });

  it("renders under StrictMode with a delayed first response", async () => {
    let release!: (response: Response) => void;
    let calls = 0;
    respond = () => {
      calls += 1;
      if (calls === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return json(report);
    };
    render(<StrictMode><ConversionsScreen me={owner} /></StrictMode>);
    // The StrictMode second run re-requests while the first answer is still held.
    await waitFor(() => expect(conversionCalls()).toHaveLength(2));
    await table();
    expect(screen.getAllByRole("row")).toHaveLength(1 + report.rows.length);
    // The held first answer lands late and must not wipe the rows.
    await act(async () => { release(json({ ...report, rows: [] })); });
    expect(screen.getAllByRole("row")).toHaveLength(1 + report.rows.length);
  });

  it("drops a late Load more response after a filter change", async () => {
    const waiting: Array<(response: Response) => void> = [];
    respond = (url) => {
      if (url.searchParams.get("limit") === "400") return new Promise<Response>((resolve) => { waiting.push(resolve); });
      const status = url.searchParams.get("status");
      return json({ ...report, rows: status ? report.rows.filter((row) => row.status === status) : report.rows, truncated: true });
    };
    render(<ConversionsScreen me={owner} />);
    await table();
    fireEvent.click(await screen.findByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(waiting).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "ส่งไม่ได้ (dead)" }));
    await waitFor(() => expect(lastCall().searchParams.get("status")).toBe("dead"));
    fireEvent.click(screen.getByRole("button", { name: "ค้างส่ง (pending)" }));
    await waitFor(() => expect(lastCall().searchParams.get("status")).toBe("pending"));
    await table();

    waiting[0]!(json(report));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The late full-window answer is dropped: the pending rows stay.
    const grid = screen.getByRole("table", { name: "รายการคอนเวอร์ชัน (Conversions)" });
    expect(within(grid).getAllByRole("row")).toHaveLength(1 + 3);
    expect(within(grid).getAllByText("ค้างส่ง")).toHaveLength(3);
    expect(within(grid).getByText("ไม่มี route (No route)")).toBeTruthy();
    expect(screen.queryByText("ลองครบแล้ว (Attempts exhausted)")).toBeNull();
    expect(lastCall().searchParams.get("limit")).toBe("200");
  });

  it("at limit 1000 with truncated the max note shows", async () => {
    respond = () => json({ ...report, truncated: true });
    render(<ConversionsScreen me={owner} />);
    for (const limit of ["400", "600", "800", "1000"]) {
      fireEvent.click(await screen.findByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
      await waitFor(() => expect(lastCall().searchParams.get("limit")).toBe(limit));
    }
    expect(await screen.findByText(`แสดง ${report.rows.length} รายการ ซึ่งเป็นจำนวนสูงสุด กรุณากรองให้แคบลง (Narrow the filters)`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "โหลดเพิ่ม (Load more)" })).toBeNull();
  }, 20000);

  it("on a narrow screen the filters sit behind the Filters button", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      render(<ConversionsScreen me={owner} />);
      await table();
      expect(screen.getByRole("button", { name: "ตัวกรอง (Filters)" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "ทั้งหมด" })).toBeNull();
      // The period segment stays outside the modal.
      expect(screen.getByRole("button", { name: "7 วัน" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "ตัวกรอง (Filters)" }));
      expect(screen.getByRole("dialog", { name: "ตัวกรองคอนเวอร์ชัน (Conversion filters)" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "ทั้งหมด" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "เสร็จ (Done)" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("readConversionFilters and conversionsPath", () => {
  it("reads the defaults, valid values and falls back for the rest", () => {
    expect(readConversionFilters("")).toEqual({ period: "7d", status: "all", brand: null });
    expect(readConversionFilters("?period=today&status=pending&brand=brand-a")).toEqual({ period: "today", status: "pending", brand: "brand-a" });
    expect(readConversionFilters("?period=30D&status=DEAD&brand=")).toEqual({ period: "7d", status: "all", brand: null });
    expect(readConversionFilters("?period=toString&status=constructor")).toEqual({ period: "7d", status: "all", brand: null });
  });

  it("writes only the values that differ from the defaults", () => {
    expect(conversionsPath({ period: "7d", status: "all", brand: null })).toBe("/conversions");
    expect(conversionsPath({ period: "30d", status: "dead", brand: null })).toBe("/conversions?period=30d&status=dead");
    expect(conversionsPath({ period: "7d", status: "dead", brand: "brand-a" })).toBe("/conversions?status=dead&brand=brand-a");
  });
});
