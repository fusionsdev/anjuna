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
    expect(sold.getByText("มี conversion (Conversion queued)")).toBeTruthy();

    const pending = rowOf(PENDING_ID);
    expect(pending.getByText("รอผล (Pending)").closest(".pill")!.className).toContain("p-blue");
    expect(pending.getByText("$500")).toBeTruthy();

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

    fireEvent.change(screen.getByLabelText(/สถานะ/), { target: { value: "sold" } });
    await waitFor(() => expect(leadRequests()).toHaveLength(2));
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

  it("confirms before a PII download for an owner and the link carries pii=1", async () => {
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
      const link = screen.getByText(PII_LABEL);
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toMatch(/&pii=1$/);

      fireEvent.click(link);
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain("audit log");
      expect(dialog.textContent).toContain("บันทึกการตรวจสอบ");
      expect(downloads).toEqual([]);

      await answerConfirm(false);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(downloads).toEqual([]);

      fireEvent.click(link);
      await answerConfirm(true);
      await waitFor(() => expect(downloads).toHaveLength(1));
      expect(downloads[0]).toBe(link.getAttribute("href"));

      // A plain CSV click needs no dialog.
      fireEvent.click(plain);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(downloads).toHaveLength(2);
    } finally {
      document.removeEventListener("click", record);
    }
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
    fireEvent.change(screen.getByLabelText(/สถานะ/), { target: { value: "rejected" } });
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
});
