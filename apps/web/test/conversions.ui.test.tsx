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
    // Rows that are not dead, and a dead row whose code has its own fix, keep the spec "UI text per code" table.
    const expected: Array<[string, string]> = [
      ["ลองครบแล้ว (Attempts exhausted)", "Drain ดึงไปแล้วไม่ตอบกลับจนครบจำนวนครั้ง. ตรวจ log ของ drain บน VPS."],
      ["ไม่มี route (No route)", "Drain ไม่รู้ว่าแบรนด์นี้ส่งเข้าบัญชี Ads ไหน. เพิ่ม route ใน drain config บน VPS."],
      ["ยังไม่พร้อม (Not ready)", "Ads ยังไม่รับ click นี้. Drain จะลองใหม่เอง."],
      ["ตั้งค่า Microsoft ไม่ครบ (Microsoft env missing)", "ตั้ง ACCOUNT และ CONVERSION_NAME ของ Microsoft Ads ใน env ของ drain."],
    ];
    for (const [label, fix] of expected) {
      const row = screen.getByText(label).closest("tr")!;
      expect(within(row).getByText(fix)).toBeTruthy();
    }
    const noRoute = screen.getByText("ไม่มี route (No route)").closest("tr")!;
    const details = noRoute.querySelector("details")!;
    expect(within(details).getByText("ข้อความเต็ม")).toBeTruthy();
    expect(details.textContent).toContain("no route for brand=brand-a hostname=a.example");
    // Dead rows with no click id or an unknown error read in plain Thai; the raw text sits behind ดูรายละเอียด.
    expect(screen.getByText("ไม่มีรหัสคลิก คนเข้าเว็บไม่ได้มาจากโฆษณา ส่งไม่ได้")).toBeTruthy();
    expect(screen.queryByText("ไม่มี click id (No click id)")).toBeNull();
    const unknown = screen.getAllByText("ส่งไม่สำเร็จ");
    expect(unknown).toHaveLength(2);
    const platform = unknown.map((cell) => cell.closest("tr")!).find((row) => row.textContent!.includes("INVALID_GCLID"))!;
    expect(within(platform.querySelector("details")!).getByText("ดูรายละเอียด")).toBeTruthy();
    expect(platform.querySelector("details")!.textContent).toContain("INVALID_GCLID: The gclid could not be decoded");
    expect(platform.querySelector("details")!.hasAttribute("open")).toBe(false);
    // The uploaded and processing rows have no reason and no error text.
    expect(document.querySelectorAll("details")).toHaveLength(7);
    expect(screen.getAllByRole("row")).toHaveLength(1 + report.rows.length);
  });

  it("names one-per-click, AdKit and no click id dead rows in plain Thai and links every row to its lead", async () => {
    const dead = report.rows.find((row) => row.status === "dead")!;
    const rows = [
      { ...dead, lead_id: "a1aaaaaa-0000-4000-8000-000000000001", reason_code: "platform_error" as const, last_error: "Command failed: adkit manage google conversions upload: CLICK_CONVERSION_ALREADY_EXISTS one-per-click" },
      { ...dead, lead_id: "a2aaaaaa-0000-4000-8000-000000000002", reason_code: "platform_error" as const, last_error: "Command failed: adkit manage google conversions upload --data {\"conversions\":[]}" },
      { ...dead, lead_id: "a3aaaaaa-0000-4000-8000-000000000003", reason_code: "no_click_id" as const, last_error: "no click id" },
    ];
    respond = () => json({ ...report, rows });
    render(<ConversionsScreen me={owner} />);
    const grid = await table();
    const rowOf = (id: string) => screen.getByRole("link", { name: `ดูลีด ${id.slice(0, 8)}` }).closest("tr")!;
    const [onePerClick, adkit, noClick] = within(grid).getAllByRole("link", { name: /^ดูลีด / }).map((link) => link.closest("tr")!);
    expect(within(onePerClick!).getByText("ส่งซ้ำ Google Ads รับครั้งเดียวต่อคลิก ไม่ต้องทำอะไร")).toBeTruthy();
    // No resend route exists yet, so the text names the failure only; the raw error sits behind ดูรายละเอียด.
    expect(within(adkit!).getByText("AdKit ขัดข้อง ส่งไม่สำเร็จ")).toBeTruthy();
    expect(within(adkit!).getByText("ดูรายละเอียด")).toBeTruthy();
    expect(within(noClick!).getByText("ไม่มีรหัสคลิก คนเข้าเว็บไม่ได้มาจากโฆษณา ส่งไม่ได้")).toBeTruthy();
    // The raw CLI text never shows outside the collapsed toggle.
    for (const row of [onePerClick!, adkit!]) expect(row.querySelector("b")!.textContent).not.toContain("Command failed");
    const link = within(rowOf(rows[1]!.lead_id)).getByRole("link", { name: /^ดูลีด / });
    expect(link.getAttribute("href")).toBe(`/leads/${rows[1]!.lead_id}`);
    fireEvent.click(link);
    expect(window.location.pathname).toBe(`/leads/${rows[1]!.lead_id}`);
  });

  it("shows the value column and value totals to the owner only", async () => {
    const view = render(<ConversionsScreen me={owner} />);
    await table();
    expect(screen.getAllByRole("columnheader")).toHaveLength(10);
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
    expect(screen.getAllByRole("columnheader")).toHaveLength(8);
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

  it("sets every number in the stat boxes in the mono face with the num class, counts and values", async () => {
    render(<ConversionsScreen me={owner} />);
    await table();
    const ledger = screen.getByRole("group", { name: "สรุปคอนเวอร์ชัน" });
    for (const label of ["ค้างส่ง", "กำลังส่ง", "ส่งแล้ว", "ส่งไม่ได้"]) expect(within(ledger).getByText(label).nextElementSibling?.classList.contains("num"), label).toBe(true);
    // The owner also sees the two value totals, and they carry num too.
    for (const label of ["มูลค่าที่ส่งแล้ว", "มูลค่าที่ส่งไม่ได้"]) expect(within(ledger).getByText(label).nextElementSibling?.classList.contains("num"), label).toBe(true);
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
    // The dead platform error row reads as unknown, and an employee gets no raw text behind it.
    expect(screen.getAllByText("ส่งไม่สำเร็จ")).toHaveLength(2);
    expect(document.querySelectorAll("details")).toHaveLength(0);
    expect(screen.getAllByRole("columnheader")).toHaveLength(8);
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
    expect(await screen.findByText(`แสดง ${report.rows.length} รายการ ซึ่งเป็นจำนวนสูงสุด กรุณากรองให้แคบลง`)).toBeTruthy();
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
    expect(await screen.findByText(`แสดง ${report.rows.length} รายการ ซึ่งเป็นจำนวนสูงสุด กรุณากรองให้แคบลง`)).toBeTruthy();
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
    // The stalled alert's cutoff: an ISO instant is kept, anything else reads as none.
    expect(readConversionFilters("?status=pending&created_before=2026-11-12T20%3A00%3A00.000Z")).toEqual({ period: "7d", status: "pending", brand: null, createdBefore: "2026-11-12T20:00:00.000Z" });
    expect(readConversionFilters("?created_before=yesterday").createdBefore).toBeUndefined();
    expect(conversionsPath({ period: "7d", status: "pending", brand: null, createdBefore: "2026-11-12T20:00:00.000Z" })).toBe("/conversions?status=pending&created_before=2026-11-12T20%3A00%3A00.000Z");
  });

  it("asks core for every row created before the stalled cutoff and says the table ignores the period", async () => {
    window.history.replaceState(null, "", "/conversions?status=pending&created_before=2026-11-12T20%3A00%3A00.000Z");
    render(<ConversionsScreen me={owner} />);
    await waitFor(() => expect(requests.some((u) => u.searchParams.get("created_before") === "2026-11-12T20:00:00.000Z" && u.searchParams.get("status") === "pending")).toBe(true));
    expect(await screen.findByText(/ตารางแสดงรายการที่สร้างก่อน .* ทุกช่วงเวลา/)).toBeTruthy();
    // No period button reads as chosen while the cutoff rules the table; a period click drops the cutoff.
    const periods = within(screen.getByRole("group", { name: "ช่วงเวลา" }));
    expect(periods.getAllByRole("button").map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false"]);
    fireEvent.click(periods.getByRole("button", { name: "30 วัน" }));
    expect(window.location.search).toBe("?period=30d&status=pending");
    window.history.replaceState(null, "", "/");
  });

  it("writes only the values that differ from the defaults", () => {
    expect(conversionsPath({ period: "7d", status: "all", brand: null })).toBe("/conversions");
    expect(conversionsPath({ period: "30d", status: "dead", brand: null })).toBe("/conversions?period=30d&status=dead");
    expect(conversionsPath({ period: "7d", status: "dead", brand: "brand-a" })).toBe("/conversions?status=dead&brand=brand-a");
  });
});

describe("Conversions page: v9 table, counts and bulk bar", () => {
  it("shows the count of each status on its chip from the report totals", async () => {
    render(<ConversionsScreen me={owner} />);
    await table();
    const t = report.totals;
    const chip = (name: string) => screen.getByRole("button", { name }).textContent;
    expect(chip("ทั้งหมด")).toContain(String(t.pending + t.processing + t.uploaded + t.dead));
    expect(chip("ค้างส่ง (pending)")).toContain(String(t.pending));
    expect(chip("ส่งแล้ว (uploaded)")).toContain(String(t.uploaded));
    expect(chip("ส่งไม่ได้ (dead)")).toContain(String(t.dead));
    expect(screen.getByRole("heading", { name: "คิวคอนเวอร์ชัน" })).toBeTruthy();
  });

  it("lets an owner pick dead rows only, shows the bulk bar and keeps ส่งใหม่ off while no retry route exists", async () => {
    render(<ConversionsScreen me={owner} />);
    const tbl = await table();
    const dead = report.rows.filter((row) => row.status === "dead");
    expect(dead.length).toBeGreaterThan(0);
    const boxes = within(tbl).getAllByRole("checkbox").filter((box) => !(box as HTMLInputElement).getAttribute("aria-label")?.startsWith("เลือกทุกรายการ"));
    expect(boxes).toHaveLength(dead.length);
    expect(screen.queryByRole("toolbar")).toBeNull();
    fireEvent.click(boxes[0]!);
    const bar = screen.getByRole("toolbar", { name: "จัดการรายการที่เลือก" });
    expect(within(bar).getByText("เลือก 1 รายการ")).toBeTruthy();
    expect((within(bar).getByRole("button", { name: "ส่งใหม่ 1 รายการ" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(tbl).getByRole("checkbox", { name: "เลือกทุกรายการที่ส่งไม่ได้" }));
    expect(within(screen.getByRole("toolbar")).getByText(`เลือก ${dead.length} รายการ`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ล้างการเลือก" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("gives an employee no pick column", async () => {
    render(<ConversionsScreen me={employee} />);
    const tbl = await table();
    expect(within(tbl).queryAllByRole("checkbox")).toHaveLength(0);
  });
});
