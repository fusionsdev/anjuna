import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadsResponse } from "@anjuna/contracts";
import leadsFixture from "@anjuna/contracts/fixtures/admin/leads.list.response.json";
import type { Me } from "../src/client/api";
import { LeadsScreen } from "../src/client/screens/Leads";
import { answerConfirm } from "./confirm";

const SOLD_ID = "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f";
const PENDING_ID = "3b7e9d10-5c2a-4f18-9a6b-1d2e3f405162";
const owner: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "u2", email: "staff@example.test", role: "employee" };
const PII_LABEL = "ดาวน์โหลด CSV พร้อม PII";

let requests: string[];
let leadResponses: LeadsResponse[];
const json = (value: unknown, status = 200) => Response.json(value, { status });

beforeEach(() => {
  window.history.replaceState(null, "", "/leads");
  requests = [];
  leadResponses = [leadsFixture as LeadsResponse];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, "https://app.test");
    if (url.pathname === "/api/leads") return json(leadResponses.length > 1 ? leadResponses.shift() : leadResponses[0]);
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "brand-a", hostnames: ["lead.example"] }], core_error: null });
    if (url.pathname === "/api/brands") return json({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
    throw new Error(`Unexpected fetch ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const leadRequests = () => requests.filter((r) => r.startsWith("/api/leads"));
const rowOf = (leadId: string) => within(screen.getByTitle(leadId).closest("tr")!);
const statusChip = (name: string) => within(screen.getByRole("group", { name: /สถานะ/ })).getByRole("button", { name: new RegExp(`^${name}`) });
const renderScreen = (me: Me = owner) => render(<LeadsScreen me={me} selectedId={null} onSelect={() => {}} />);

describe("Leads screen", () => {
  it("lists leads newest first with the domain, outcome badge and amount", async () => {
    const { container } = renderScreen();
    await screen.findByTitle(SOLD_ID);
    const ids = within(container.querySelector("tbody")!).getAllByRole("link").map((a) => a.getAttribute("title"));
    expect(ids).toEqual([SOLD_ID, PENDING_ID]);

    const sold = rowOf(SOLD_ID);
    expect(sold.getAllByRole("cell").map((c) => c.textContent)).toContain("lead.examplebrand-a");
    expect(sold.getByText("lead.example").closest("td")!.firstElementChild!.textContent!.startsWith("lead.example")).toBe(true);
    expect(sold.getByText("brand-a").tagName).toBe("CODE");
    expect(sold.getByText("ขายได้ (Sold)").closest(".pill")!.className).toContain("p-live");
    expect(sold.getByText("$1,000")).toBeTruthy();
    expect(sold.getByText("Fast Cash Loans")).toBeTruthy();
    expect(sold.getByText("มี conversion (Has conversion)").closest(".pill")!.className).toContain("p-live");

    const pending = rowOf(PENDING_ID);
    expect(pending.getByText("รอผล (Pending)").closest(".pill")!.className).toContain("p-blue");
    expect(pending.getByText("$500")).toBeTruthy();
    expect(pending.getByText("ยังไม่มี postback (No postback yet)").closest(".pill")!.className).toContain("p-warn");

    expect(leadRequests()).toHaveLength(1);
    expect(leadRequests()[0]).toMatch(/^\/api\/leads\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  });

  it("sends the last 30 days in UTC and writes filter changes to the URL query string", async () => {
    window.history.replaceState(null, "", "/leads?brand=brand-a&status=pending");
    renderScreen();
    await screen.findByTitle(SOLD_ID);
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10);
    expect(leadRequests()[0]).toBe(`/api/leads?from=${from}&to=${today}&brand=brand-a&status=pending`);

    // A filter write replaces the history entry instead of pushing one.
    const historyLength = window.history.length;
    fireEvent.click(statusChip("ขายได้"));
    await waitFor(() => expect(leadRequests()).toHaveLength(2));
    expect(window.history.length).toBe(historyLength);
    expect(leadRequests()[1]).toBe(`/api/leads?from=${from}&to=${today}&brand=brand-a&status=sold`);
    const search = new URLSearchParams(window.location.search);
    expect(search.get("status")).toBe("sold");
    expect(search.get("brand")).toBe("brand-a");
    expect(search.get("from")).toBe(from);
    expect(window.location.pathname).toBe("/leads");

    fireEvent.change(screen.getByLabelText(/ค้นหา \(Search\)$/), { target: { value: "6f1c2b9e" } });
    fireEvent.click(screen.getByRole("button", { name: "ค้นหา (Search)" }));
    await waitFor(() => expect(leadRequests()).toHaveLength(3));
    expect(leadRequests()[2]).toContain("q=6f1c2b9e");
    expect(window.location.search).toContain("q=6f1c2b9e");
  });

  it("hides the PII CSV button from an employee", async () => {
    const { container } = renderScreen(employee);
    await screen.findByTitle(SOLD_ID);
    expect(screen.queryByText(PII_LABEL)).toBeNull();
    expect(container.innerHTML).not.toContain("pii=1");
    const plain = screen.getByText("ดาวน์โหลด CSV");
    expect(plain.tagName).toBe("A");
    expect(plain.getAttribute("href")).toMatch(/^\/api\/leads\/export\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  });

  it("confirms every PII download for an owner and keeps no PII href in the DOM", async () => {
    // Clicks that reach the document without preventDefault are the ones the browser would follow.
    const downloads: string[] = [];
    const record = (e: Event) => {
      const link = (e.target as HTMLElement).closest("a");
      if (link?.getAttribute("href")?.includes("/export") && !e.defaultPrevented) downloads.push(link.getAttribute("href")!);
      e.preventDefault();
    };
    document.addEventListener("click", record);
    try {
      renderScreen();
      await screen.findByTitle(SOLD_ID);
      const plain = screen.getByText("ดาวน์โหลด CSV");
      expect(plain.getAttribute("href")).not.toContain("pii");
      // A button, so a middle click or "Save link as" has no href to follow past the dialog.
      const control = screen.getByText(PII_LABEL);
      expect(control.tagName).toBe("BUTTON");
      expect(control.hasAttribute("href")).toBe(false);
      expect(document.body.innerHTML).not.toContain("pii=1");

      fireEvent.click(control);
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain("audit log");
      expect(dialog.textContent).toContain("บันทึกการตรวจสอบ");
      expect(downloads).toEqual([]);

      await answerConfirm(false);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(downloads).toEqual([]);

      fireEvent.click(control);
      await answerConfirm(true);
      await waitFor(() => expect(downloads).toHaveLength(1));
      expect(downloads[0]).toBe(`${plain.getAttribute("href")}&pii=1`);
      expect(document.body.innerHTML).not.toContain("pii=1");

      // The approval does not carry over: the next PII click asks again.
      fireEvent.click(control);
      expect(await screen.findByRole("alertdialog")).toBeTruthy();
      expect(downloads).toHaveLength(1);
      await answerConfirm(true);
      await waitFor(() => expect(downloads).toHaveLength(2));

      // A plain CSV click needs no dialog.
      fireEvent.click(plain);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(downloads).toHaveLength(3);
    } finally {
      document.removeEventListener("click", record);
    }
  });

  it("applies the reconciliation rules in order with the detail screen's tones", async () => {
    const base = (leadsFixture as LeadsResponse).rows[0]!;
    const ids = ["aaaa0001-0000-4000-8000-000000000001", "aaaa0002-0000-4000-8000-000000000002", "aaaa0003-0000-4000-8000-000000000003", "aaaa0004-0000-4000-8000-000000000004"];
    leadResponses = [{
      rows: [
        { ...base, lead_id: ids[0]!, outcome: "sold", has_conversion: true, postback_count: 0 },
        { ...base, lead_id: ids[1]!, outcome: "sold", has_conversion: false, postback_count: 2 },
        { ...base, lead_id: ids[2]!, outcome: "pending", has_conversion: false, postback_count: 0 },
        { ...base, lead_id: ids[3]!, outcome: "rejected", has_conversion: false, postback_count: 1 },
      ],
      next_cursor: null,
    }];
    renderScreen();
    await screen.findByTitle(ids[0]!);
    const badge = (id: string) => rowOf(id).getAllByRole("cell")[7]!.querySelector(".pill")!;
    expect([badge(ids[0]!).textContent, badge(ids[0]!).className]).toEqual(["●มี conversion (Has conversion)", expect.stringContaining("p-live")]);
    expect([badge(ids[1]!).textContent, badge(ids[1]!).className]).toEqual(["✕ขายแล้วแต่ไม่มีรายการอัปโหลด (Sold, no upload)", expect.stringContaining("p-bad")]);
    expect([badge(ids[2]!).textContent, badge(ids[2]!).className]).toEqual(["▲ยังไม่มี postback (No postback yet)", expect.stringContaining("p-warn")]);
    expect([badge(ids[3]!).textContent, badge(ids[3]!).className]).toEqual(["◆มี postback (Postback received)", expect.stringContaining("p-blue")]);
  });

  it("refuses a search under 4 characters on submit: no list request, no live export link, an inline reason", async () => {
    const { container } = renderScreen();
    await screen.findByTitle(SOLD_ID);
    expect(leadRequests()).toHaveLength(1);

    fireEvent.change(screen.getByLabelText(/ค้นหา \(Search\)$/), { target: { value: "ab" } });
    fireEvent.click(screen.getByRole("button", { name: "ค้นหา (Search)" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^คำค้น/);
    expect(leadRequests()).toHaveLength(1);
    expect(container.querySelector('a[href*="/export"]')).toBeNull();
    expect((screen.getByRole("button", { name: "ดาวน์โหลด CSV" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: PII_LABEL }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTitle(SOLD_ID)).toBeNull();

    // A valid search loads again and brings the link back.
    fireEvent.change(screen.getByLabelText(/ค้นหา \(Search\)$/), { target: { value: "6f1c2b9e" } });
    fireEvent.click(screen.getByRole("button", { name: "ค้นหา (Search)" }));
    await waitFor(() => expect(leadRequests()).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("ดาวน์โหลด CSV").getAttribute("href")).toContain("q=6f1c2b9e");
  });

  it.each([
    ["/leads?q=ab", /^คำค้น/],
    ["/leads?q=bad%20id!", /^คำค้น/],
    ["/leads?from=2026-10-10&to=2026-10-01", /^วันเริ่มต้องไม่อยู่หลังวันสิ้นสุด/],
    ["/leads?from=2026-01-01&to=2026-10-01", /^ช่วงวันที่ยาวเกิน 93 วัน/],
    ["/leads?brand=Bad%20Brand!", /^รหัสแบรนด์ไม่ถูกต้อง/],
  ])("refuses the deep link %s: no list request, no live export link, an inline reason", async (path, reason) => {
    window.history.replaceState(null, "", path);
    const { container } = renderScreen();
    expect((await screen.findByRole("alert")).textContent).toMatch(reason);
    await waitFor(() => expect(requests).toContain("/api/brands"));
    expect(leadRequests()).toEqual([]);
    expect(container.querySelector('a[href*="/export"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain("/api/leads/export");
    expect((screen.getByRole("button", { name: "ดาวน์โหลด CSV" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: PII_LABEL }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pages with next_cursor and keeps the cursor out of the URL", async () => {
    const second: LeadsResponse = { rows: [{ ...(leadsFixture as LeadsResponse).rows[0]!, lead_id: "9a8b7c6d-1111-4222-8333-444455556666" }], next_cursor: null };
    leadResponses = [leadsFixture as LeadsResponse, second];
    renderScreen();
    await screen.findByTitle(SOLD_ID);
    fireEvent.click(screen.getByRole("button", { name: "ถัดไป (Next)" }));
    await screen.findByTitle("9a8b7c6d-1111-4222-8333-444455556666");
    expect(leadRequests()).toHaveLength(2);
    expect(leadRequests()[1]).toContain(`cursor=${(leadsFixture as LeadsResponse).next_cursor}`);
    expect(window.location.search).not.toContain("cursor");
    expect(screen.queryByRole("button", { name: "ถัดไป (Next)" })).toBeNull();

    // A filter change goes back to page 1.
    fireEvent.click(statusChip("ถูกปฏิเสธ"));
    await waitFor(() => expect(leadRequests()).toHaveLength(3));
    expect(leadRequests()[2]).not.toContain("cursor");
    expect(leadRequests()[2]).toContain("status=rejected");
  });

  it("shows an empty state that distinguishes no leads from no match", async () => {
    leadResponses = [{ rows: [], next_cursor: null }];
    const first = renderScreen();
    expect(await screen.findByText("ยังไม่มีลีดในช่วงนี้ (No leads in this window)")).toBeTruthy();
    expect(screen.queryByText(/ไม่พบลีดที่ตรงกับตัวกรอง/)).toBeNull();
    first.unmount();

    window.history.replaceState(null, "", "/leads?status=sold");
    renderScreen();
    expect(await screen.findByText("ไม่พบลีดที่ตรงกับตัวกรอง (No leads match this filter)")).toBeTruthy();
    expect(screen.queryByText(/ยังไม่มีลีดในช่วงนี้/)).toBeNull();
  });

  it("renders a row whose keyword and variant are null without printing null", async () => {
    const { container } = renderScreen();
    await screen.findByTitle(PENDING_ID);
    const cells = rowOf(PENDING_ID).getAllByRole("cell");
    expect(cells[5]!.textContent).toBe("");
    expect(cells[6]!.textContent).toBe("");
    expect(container.textContent).not.toContain("null");
  });

  it("on a narrow screen the filters sit behind the Filters button", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      window.history.replaceState(null, "", "/leads?status=sold");
      renderScreen();
      expect(screen.getByRole("button", { name: "ตัวกรอง (Filters) (1)" })).toBeTruthy();
      expect(screen.queryByLabelText(/สถานะ/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "ตัวกรอง (Filters) (1)" }));
      expect(screen.getByRole("dialog", { name: "ตัวกรองลีด (Lead filters)" })).toBeTruthy();
      expect(screen.getByLabelText(/สถานะ/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "เสร็จ (Done)" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await screen.findByTitle(SOLD_ID);
    } finally {
      window.matchMedia = original;
    }
  });

  it("counts a From/To range that differs from the default 30 days", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      // The default window counts nothing.
      const first = renderScreen();
      expect(screen.getByRole("button", { name: "ตัวกรอง (Filters)" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /ตัวกรอง \(Filters\) \(\d+\)/ })).toBeNull();
      await screen.findByTitle(SOLD_ID);
      first.unmount();

      // A custom 7-day window counts 1.
      const today = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.parse(today) - 6 * 86_400_000).toISOString().slice(0, 10);
      window.history.replaceState(null, "", `/leads?from=${from}&to=${today}`);
      renderScreen();
      expect(screen.getByRole("button", { name: "ตัวกรอง (Filters) (1)" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "ตัวกรอง (Filters) (1)" }));
      expect(screen.getByRole("dialog", { name: "ตัวกรองลีด (Lead filters)" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "เสร็จ (Done)" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await screen.findByTitle(SOLD_ID);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("Leads screen: chips, range and the lead panel", () => {
  it("counts the loaded rows on the status chips and sends the chosen status", async () => {
    renderScreen();
    await screen.findByTitle(SOLD_ID);
    const group = screen.getByRole("group", { name: /สถานะ/ });
    const rows = (leadsFixture as LeadsResponse).rows;
    const text = (name: string) => within(group).getByRole("button", { name: new RegExp(`^${name}`) }).textContent;
    expect(text("ทั้งหมด")).toContain(`${rows.length}`);
    expect(text("ขายได้")).toContain(`${rows.filter((r) => r.outcome === "sold").length}`);
    expect(text("รอผล")).toContain(`${rows.filter((r) => r.outcome === "pending").length}`);
    fireEvent.click(statusChip("รอผล"));
    await waitFor(() => expect(leadRequests()).toHaveLength(2));
    expect(leadRequests()[1]).toContain("status=pending");
    expect(statusChip("รอผล").getAttribute("aria-pressed")).toBe("true");
  });

  it("sets the window from the range buttons and writes it to the URL", async () => {
    renderScreen();
    await screen.findByTitle(SOLD_ID);
    const today = new Date().toISOString().slice(0, 10);
    const from7 = new Date(Date.parse(today) - 6 * 86_400_000).toISOString().slice(0, 10);
    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await waitFor(() => expect(leadRequests()).toHaveLength(2));
    expect(leadRequests()[1]).toBe(`/api/leads?from=${from7}&to=${today}`);
    expect(screen.getByRole("button", { name: "7 วัน" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "วันนี้" }));
    await waitFor(() => expect(leadRequests()).toHaveLength(3));
    expect(leadRequests()[2]).toBe(`/api/leads?from=${today}&to=${today}`);
  });

  it("opens a lead from its row button, marks the row and shows the panel beside the table", async () => {
    const onSelect = vi.fn();
    const view = render(<LeadsScreen me={owner} selectedId={null} onSelect={onSelect} />);
    await screen.findByTitle(SOLD_ID);
    fireEvent.click(within(screen.getByTitle(SOLD_ID).closest("tr")!).getByRole("button", { name: "ดูรายละเอียดลีด 6f1c2b9e" }));
    expect(onSelect).toHaveBeenCalledWith(SOLD_ID);
    expect(view.container.querySelector(".lead-panel")).toBeNull();
  });
});

describe("Leads exact window from an alert link (FUS-392)", () => {
  const FROM = "2026-11-12T02:00:00.000Z";
  const TO = "2026-11-13T02:00:00.000Z";

  it("sends the alert's instants and time=decided to core and says which leads the list holds", async () => {
    window.history.replaceState(null, "", `/leads?brand=brand-a&status=rejected&time=decided&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);
    renderScreen();
    await waitFor(() => expect(leadRequests()).toHaveLength(1));
    const url = new URL(leadRequests()[0]!, "https://app.test");
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: FROM, to: TO, time: "decided", brand: "brand-a", status: "rejected" });
    expect(screen.getByText(/^ลีดที่ได้ผลจาก LeadsGate ตั้งแต่/)).toBeTruthy();
    // The date inputs show the days of the instants.
    expect((screen.getByLabelText("ตั้งแต่ (From)") as HTMLInputElement).value).toBe("2026-11-12");
  });

  it("keeps day values working and leaves the exact window on a date edit", async () => {
    window.history.replaceState(null, "", `/leads?time=decided&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);
    renderScreen();
    await screen.findByTitle(SOLD_ID);
    fireEvent.change(screen.getByLabelText("ถึง (To)"), { target: { value: "2026-11-14" } });
    expect(new URLSearchParams(window.location.search).toString()).toBe("from=2026-11-12&to=2026-11-14");
    await waitFor(() => expect(leadRequests().at(-1)).toBe("/api/leads?from=2026-11-12&to=2026-11-14"));
  });
});
