import errorsFixture from "@anjuna/contracts/fixtures/admin/client-errors.response.json";
import { CLIENT_ERROR_TYPES_LIMIT, type ClientErrorsResponse } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { ClientErrorsScreen, clientErrorsPath, readClientErrorFilters } from "../src/client/screens/ClientErrors";

const fixture = errorsFixture as ClientErrorsResponse;
const owner: Me = { id: "owner", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "employee", email: "employee@example.test", role: "employee" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const table = () => screen.findByRole("table", { name: "ข้อผิดพลาดฝั่งเว็บ (Client errors)" });
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
const errorCalls = () => requests.filter((url) => url.pathname === "/api/client-errors");
const row = (id: number, patch: Partial<ClientErrorsResponse["rows"][number]> = {}): ClientErrorsResponse["rows"][number] => ({
  id, occurred_at: `2026-11-02T08:00:${String(id % 60).padStart(2, "0")}.000Z`, error_type: "timeout", error_message: `message ${id}`,
  screen_id: "step-1", hostname: "brand-a.example", brand_id: "brand-a", session_ref: "3f9a1c0be274", ...patch,
});
const bodyRows = async () => within(await table()).getAllByRole("row").slice(1);

let requests: URL[];
let respond: (url: URL) => Response | Promise<Response>;

beforeEach(() => {
  window.history.replaceState(null, "", "/errors");
  requests = [];
  respond = (url) => json({ ...fixture, period: url.searchParams.get("period") });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, window.location.origin);
    requests.push(url);
    if (url.pathname === "/api/client-errors") return respond(url);
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

describe("Client errors screen", () => {
  it("loads 24h errors and shows a chip per type with its count", async () => {
    respond = (url) => json({ ...fixture, period: url.searchParams.get("period"), rows: fixture.rows.map((r, i) => (i === 1 ? { ...r, occurred_at: "2026-11-02 12:20:11" } : r)) });
    render(<ClientErrorsScreen me={owner} />);
    const rows = await bodyRows();
    expect(errorCalls()).toHaveLength(1);
    expect(errorCalls()[0]!.searchParams.get("period")).toBe("24h");
    for (const key of ["brand_id", "error_type", "cursor"]) expect(errorCalls()[0]!.searchParams.has(key)).toBe(false);
    expect(pressed("24 ชม. (24h)")).toBe("true");
    expect(pressed("7 วัน (7d)")).toBe("false");

    const chips = within(screen.getByRole("group", { name: "ประเภท" })).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["ทั้งหมด 3", "timeout 2", "submission_error 1"]);
    expect(pressed("ทั้งหมด 3")).toBe("true");
    expect(pressed("timeout 2")).toBe("false");

    expect(rows).toHaveLength(3);
    const cells = within(rows[0]!).getAllByRole("cell").map((cell) => cell.textContent);
    // The time is the stored text, not a locale-formatted date.
    expect(cells[0]).toBe("2026-11-02T12:20:11.000Z");
    expect(cells[1]).toBe("timeout");
    await waitFor(() => expect(within(rows[0]!).getAllByRole("cell")[2]!.textContent).toContain("a.example"));
    expect(cells[3]).toBe("step-2");
    expect(within(await table()).getByRole("columnheader", { name: "เวลา (UTC)" })).toBeTruthy();
    // A stored value that is not ISO text shows exactly as stored.
    expect(within(rows[1]!).getAllByRole("cell")[0]!.textContent).toBe("2026-11-02 12:20:11");
    expect(cells[4]).toBe("3f9a1c0be274");
    expect(cells[5]).toBe("Request timed out");
    expect(within(rows[0]!).getByText("3f9a1c0be274").className).toContain("mono");
    // A null brand, screen and session read as a dash.
    expect(within(rows[1]!).getAllByRole("cell")[3]!.textContent).toBe("—");
    const orphan = within(rows[2]!).getAllByRole("cell").map((cell) => cell.textContent);
    expect([orphan[2], orphan[4]]).toEqual(["—", "—"]);
    expect(document.body.textContent).not.toMatch(/null/);
  });

  it("a type chip navigates to /errors?type=timeout and refetches with error_type", async () => {
    render(<ClientErrorsScreen me={owner} />);
    await table();
    const entries = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "timeout 2" }));
    expect(window.location.pathname + window.location.search).toBe("/errors?type=timeout");
    expect(window.history.length).toBe(entries);
    await waitFor(() => expect(errorCalls()).toHaveLength(2));
    expect(errorCalls()[1]!.searchParams.get("error_type")).toBe("timeout");
    await table();
    expect(pressed("timeout 2")).toBe("true");
    // Counts ignore the type filter in core, so every chip stays.
    expect(within(screen.getByRole("group", { name: "ประเภท" })).getAllByRole("button")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "ทั้งหมด 3" }));
    expect(window.location.pathname + window.location.search).toBe("/errors");
    await waitFor(() => expect(errorCalls()).toHaveLength(3));
    expect(errorCalls()[2]!.searchParams.has("error_type")).toBe(false);
  });

  it("keeps a selected type visible when the response holds no such type", async () => {
    window.history.replaceState(null, "", "/errors?type=gone");
    respond = () => json({ ...fixture, counts: [], rows: [] });
    render(<ClientErrorsScreen me={owner} />);
    await table();
    expect(pressed("gone 0")).toBe("true");
    expect(pressed("ทั้งหมด 0")).toBe("false");
  });

  it("a period chip navigates and refetches with that period", async () => {
    render(<ClientErrorsScreen me={owner} />);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "30 วัน (30d)" }));
    expect(window.location.pathname + window.location.search).toBe("/errors?period=30d");
    await waitFor(() => expect(errorCalls()).toHaveLength(2));
    expect(errorCalls()[1]!.searchParams.get("period")).toBe("30d");
    expect(pressed("30 วัน (30d)")).toBe("true");
  });

  it("the brand select navigates to /errors?brand=brand-a and refetches with brand_id", async () => {
    render(<ClientErrorsScreen me={owner} />);
    await table();
    const select = screen.getByRole("combobox", { name: "แบรนด์" });
    expect(within(select).getByRole("option", { name: "ทุกแบรนด์" })).toBeTruthy();
    await waitFor(() => expect(within(select).getByRole("option", { name: "a.example (brand-a)" })).toBeTruthy());
    fireEvent.change(select, { target: { value: "brand-a" } });
    expect(window.location.pathname + window.location.search).toBe("/errors?brand=brand-a");
    await waitFor(() => expect(errorCalls()).toHaveLength(2));
    expect(errorCalls()[1]!.searchParams.get("brand_id")).toBe("brand-a");
    expect((select as unknown as HTMLSelectElement).value).toBe("brand-a");

    fireEvent.change(select, { target: { value: "" } });
    expect(window.location.pathname + window.location.search).toBe("/errors");
    await waitFor(() => expect(errorCalls()).toHaveLength(3));
    expect(errorCalls()[2]!.searchParams.has("brand_id")).toBe(false);
  });

  it("readClientErrorFilters drops an unknown period, a bad brand and an empty type", () => {
    expect(readClientErrorFilters("")).toEqual({ period: "24h", brand: null, type: null });
    expect(readClientErrorFilters("?period=7d&brand=brand-a&type=timeout")).toEqual({ period: "7d", brand: "brand-a", type: "timeout" });
    expect(readClientErrorFilters("?period=bogus&brand=Not%20A%20Brand&type=")).toEqual({ period: "24h", brand: null, type: null });
    expect(readClientErrorFilters("?period=toString").period).toBe("24h");
    expect(readClientErrorFilters("?brand=BRAND_A").brand).toBeNull();
    expect(readClientErrorFilters(`?type=${"x".repeat(64)}`).type).toBe("x".repeat(64));
    expect(readClientErrorFilters(`?type=${"x".repeat(65)}`).type).toBeNull();
    expect(clientErrorsPath({ period: "24h", brand: null, type: null })).toBe("/errors");
    expect(clientErrorsPath({ period: "7d", brand: "brand-a", type: "time out" })).toBe("/errors?period=7d&brand=brand-a&type=time+out");
    expect(readClientErrorFilters(clientErrorsPath({ period: "7d", brand: "brand-a", type: "time out" }).split("?")[1]!).type).toBe("time out");
  });

  it("Load more appends the next page with the cursor and hides when next_cursor is null", async () => {
    const first = { ...fixture, rows: [row(52), row(51)], next_cursor: "51" };
    const second = { ...fixture, rows: [row(50)], next_cursor: null };
    respond = (url) => json(url.searchParams.get("cursor") === "51" ? second : first);
    render(<ClientErrorsScreen me={owner} />);
    expect(await bodyRows()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(errorCalls()).toHaveLength(2));
    expect(errorCalls()[1]!.searchParams.get("cursor")).toBe("51");
    expect(errorCalls()[1]!.searchParams.get("period")).toBe("24h");
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(1 + 3));
    const text = (await table()).textContent!;
    expect(text.indexOf("message 52")).toBeLessThan(text.indexOf("message 51"));
    expect(text.indexOf("message 51")).toBeLessThan(text.indexOf("message 50"));
    expect(screen.queryByRole("button", { name: "โหลดเพิ่ม (Load more)" })).toBeNull();
    // The chips come from the first page and are not replaced.
    expect(screen.getByRole("button", { name: "timeout 2" })).toBeTruthy();
  });

  it("Load more keeps the active filters in the paging request and shows a failure without dropping rows", async () => {
    window.history.replaceState(null, "", "/errors?period=7d&brand=brand-a&type=timeout");
    respond = (url) => (url.searchParams.has("cursor") ? json({ error: "internal" }, 500) : json({ ...fixture, rows: [row(9)], next_cursor: "9" }));
    render(<ClientErrorsScreen me={owner} />);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("โหลดเพิ่มไม่สำเร็จ");
    expect(failure.className).toContain("ce-error");
    const paged = errorCalls()[1]!.searchParams;
    expect([paged.get("period"), paged.get("brand_id"), paged.get("error_type"), paged.get("cursor")]).toEqual(["7d", "brand-a", "timeout", "9"]);
    expect(await bodyRows()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" })).toBeTruthy();
  });

  it("an employee sees — (Owner only) for a hidden message; an owner sees the message", async () => {
    const hidden = { ...fixture, rows: fixture.rows.map((r) => ({ ...r, error_message: null })) };
    respond = () => json(hidden);
    const view = render(<ClientErrorsScreen me={employee} />);
    const rows = await bodyRows();
    expect(rows.map((r) => within(r).getAllByRole("cell")[5]!.textContent)).toEqual(["— (Owner only)", "— (Owner only)", "— (Owner only)"]);
    view.unmount();

    respond = () => json({ ...fixture, rows: [fixture.rows[0]!, { ...fixture.rows[1]!, error_message: "" }, fixture.rows[2]!] });
    render(<ClientErrorsScreen me={owner} />);
    const ownerRows = await bodyRows();
    expect(ownerRows.map((r) => within(r).getAllByRole("cell")[5]!.textContent)).toEqual(["Request timed out", "—", "—"]);
    expect(document.body.textContent).not.toContain("Owner only");
  });

  it("renders a message as text, never as HTML", async () => {
    const payload = `<img src=x onerror="alert(1)"><b>bold</b>`;
    respond = () => json({ ...fixture, rows: [row(1, { error_message: payload })] });
    render(<ClientErrorsScreen me={owner} />);
    const rows = await bodyRows();
    expect(within(rows[0]!).getByText(payload)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(rows[0]!.querySelector("b")).toBeNull();
  });

  it("a filter change drops the appended pages", async () => {
    const first = { ...fixture, rows: [row(52), row(51)], next_cursor: "51" };
    const second = { ...fixture, rows: [row(50)], next_cursor: null };
    respond = (url) => {
      if (url.searchParams.get("error_type") === "timeout") return json({ ...fixture, rows: [row(7)], next_cursor: null });
      return json(url.searchParams.get("cursor") === "51" ? second : first);
    };
    render(<ClientErrorsScreen me={owner} />);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(1 + 3));

    fireEvent.click(screen.getByRole("button", { name: "timeout 2" }));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(1 + 1));
    expect((await table()).textContent).toContain("message 7");
    expect((await table()).textContent).not.toContain("message 50");
    expect(screen.queryByRole("button", { name: "โหลดเพิ่ม (Load more)" })).toBeNull();
  });

  it("drops a late page and a late first load that belong to the previous filter", async () => {
    const waiting: Array<{ url: URL; resolve: (response: Response) => void }> = [];
    respond = (url) => new Promise<Response>((resolve) => { waiting.push({ url, resolve }); });
    render(<ClientErrorsScreen me={owner} />);
    await waitFor(() => expect(waiting).toHaveLength(1));
    waiting[0]!.resolve(json({ ...fixture, rows: [row(52)], next_cursor: "52" }));
    await table();

    // Start a page for the old filter, then change the filter before it answers.
    fireEvent.click(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(waiting).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "30 วัน (30d)" }));
    await waitFor(() => expect(waiting).toHaveLength(3));
    expect(waiting[2]!.url.searchParams.get("period")).toBe("30d");
    expect(waiting[2]!.url.searchParams.has("cursor")).toBe(false);

    waiting[2]!.resolve(json({ ...fixture, rows: [row(7)], next_cursor: null }));
    await waitFor(() => expect(screen.getByRole("table").textContent).toContain("message 7"));
    await act(async () => {
      waiting[1]!.resolve(json({ ...fixture, rows: [row(51)], next_cursor: null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("table").textContent).not.toContain("message 51");
    expect(screen.getByRole("table").textContent).toContain("message 7");
    expect(await bodyRows()).toHaveLength(1);
  });

  it("drops a first load that answers after the period changed", async () => {
    const waiting: Array<{ url: URL; resolve: (response: Response) => void }> = [];
    respond = (url) => new Promise<Response>((resolve) => { waiting.push({ url, resolve }); });
    render(<ClientErrorsScreen me={owner} />);
    await waitFor(() => expect(waiting).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "30 วัน (30d)" }));
    await waitFor(() => expect(waiting).toHaveLength(2));
    expect(waiting[1]!.url.searchParams.get("period")).toBe("30d");

    waiting[1]!.resolve(json({ ...fixture, counts: [{ error_type: "new_type", count: 9 }], rows: [row(7)], next_cursor: null }));
    await waitFor(() => expect(screen.getByRole("table").textContent).toContain("message 7"));
    await act(async () => {
      waiting[0]!.resolve(json({ ...fixture, rows: [row(52)], next_cursor: null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("table").textContent).not.toContain("message 52");
    expect(await bodyRows()).toHaveLength(1);
    const chips = within(screen.getByRole("group", { name: "ประเภท" })).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["ทั้งหมด 9", "new_type 9"]);
  });

  it("keeps every chip, and the clicked one, while a type request is held and after it fails", async () => {
    const held: Array<(response: Response) => void> = [];
    respond = (url) => (url.searchParams.has("error_type") ? new Promise<Response>((resolve) => { held.push(resolve); }) : json(fixture));
    render(<ClientErrorsScreen me={owner} />);
    await table();
    const chip = screen.getByRole("button", { name: "timeout 2" });
    chip.focus();
    fireEvent.click(chip);
    await waitFor(() => expect(held).toHaveLength(1));

    const names = () => within(screen.getByRole("group", { name: "ประเภท" })).getAllByRole("button").map((button) => button.textContent);
    expect(screen.queryByRole("table")).toBeNull();
    expect(names()).toEqual(["ทั้งหมด 3", "timeout 2", "submission_error 1"]);
    expect(screen.getByRole("button", { name: "timeout 2" })).toBe(chip);
    expect(document.activeElement).toBe(chip);
    expect(pressed("timeout 2")).toBe("true");

    held[0]!(json({ error: "internal" }, 500));
    await screen.findByRole("alert");
    expect(names()).toEqual(["ทั้งหมด 3", "timeout 2", "submission_error 1"]);
  });

  it("drops the counts when the period or the brand changes, not before", async () => {
    const held: Array<(response: Response) => void> = [];
    respond = (url) => (url.searchParams.get("period") === "7d" ? new Promise<Response>((resolve) => { held.push(resolve); }) : json(fixture));
    render(<ClientErrorsScreen me={owner} />);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "7 วัน (7d)" }));
    await waitFor(() => expect(held).toHaveLength(1));
    expect(within(screen.getByRole("group", { name: "ประเภท" })).getAllByRole("button").map((button) => button.textContent)).toEqual(["ทั้งหมด"]);
  });

  it("shows no number on the all chip when the types list is at its cap", async () => {
    const counts = (n: number) => Array.from({ length: n }, (_, i) => ({ error_type: `type_${i}`, count: 1 }));
    respond = () => json({ ...fixture, counts: counts(CLIENT_ERROR_TYPES_LIMIT), rows: [] });
    const view = render(<ClientErrorsScreen me={owner} />);
    await table();
    const first = () => within(screen.getByRole("group", { name: "ประเภท" })).getAllByRole("button")[0]!;
    expect(first().textContent).toBe("ทั้งหมด");
    view.unmount();

    // A selected type that is missing from the counts adds a chip but is not a real type.
    window.history.replaceState(null, "", "/errors?type=gone");
    respond = () => json({ ...fixture, counts: counts(CLIENT_ERROR_TYPES_LIMIT - 1), rows: [] });
    render(<ClientErrorsScreen me={owner} />);
    await table();
    expect(first().textContent).toBe(`ทั้งหมด ${CLIENT_ERROR_TYPES_LIMIT - 1}`);
  });

  it("reads unknown URL values as the defaults and sends only the period", async () => {
    window.history.replaceState(null, "", "/errors?period=bogus&brand=Bad&type=");
    render(<ClientErrorsScreen me={owner} />);
    await table();
    expect([...errorCalls()[0]!.searchParams.keys()]).toEqual(["period"]);
    expect(errorCalls()[0]!.searchParams.get("period")).toBe("24h");
    expect(pressed("24 ชม. (24h)")).toBe("true");
    expect(pressed("ทั้งหมด 3")).toBe("true");
  });

  it("shows the empty state, the spinner and the error card with Retry", async () => {
    respond = () => json({ ...fixture, counts: [], rows: [] });
    const view = render(<ClientErrorsScreen me={owner} />);
    expect(screen.getByRole("status").textContent).toContain("กำลังโหลด");
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(await table()).getByText("ไม่มีข้อผิดพลาดในช่วงนี้")).toBeTruthy();
    view.unmount();

    respond = () => json({ error: "internal" }, 500);
    render(<ClientErrorsScreen me={owner} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("เกิดข้อผิดพลาด (500)");
    expect(screen.queryByRole("table")).toBeNull();
    // The red tone lives on .note.ce-error, because styles.css loads after Traffic.css and .note would win.
    expect(alert.className).toContain("ce-error");
    const before = errorCalls().length;

    respond = (url) => json({ ...fixture, period: url.searchParams.get("period") });
    fireEvent.click(screen.getByRole("button", { name: "ลองอีกครั้ง" }));
    expect(await bodyRows()).toHaveLength(3);
    expect(errorCalls()).toHaveLength(before + 1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
