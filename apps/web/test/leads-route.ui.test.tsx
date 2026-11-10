import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadsResponse } from "@anjuna/contracts";
import leadsFixture from "@anjuna/contracts/fixtures/admin/leads.list.response.json";
import ownerLeadFixture from "@anjuna/contracts/fixtures/admin/lead.get.response.json";
import { App } from "../src/client/App";
import { api, type Me } from "../src/client/api";

// The real App with the real Leads, Lead detail and Suppressions screens.
const LEAD_ID = "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f";
const APPLICANT_EMAIL = "test.applicant@example.com";
const owner: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "u2", email: "staff@example.test", role: "employee" };
const LEADS_NAV = "ลีด (Leads)"; // the screen heading
const LEADS_MENU = "ลีดและคอนเวอร์ชัน";
const LEADS_TAB = "ลีด";
const SUPPRESSIONS_TAB = "อีเมลที่บล็อก";
const OWNER_ONLY = "สำหรับ Owner เท่านั้น (Owner only)";

let requests: string[];
const json = (body: unknown, status = 200) => Response.json(body, { status });
const back = () => act(async () => {
  window.history.back();
  await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
});
const menu = () => within(screen.getByRole("navigation", { name: "เมนูหลัก" }));
const tabs = () => within(screen.getByRole("navigation", { name: "หมวดย่อย" }));
const tabLabels = () => tabs().getAllByRole("link").map((a) => a.textContent);

beforeEach(() => {
  requests = [];
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("Unavailable"));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, "https://app.test");
    if (url.pathname === "/api/leads") return json(leadsFixture as LeadsResponse);
    if (url.pathname === `/api/leads/${LEAD_ID}`) return json(ownerLeadFixture);
    if (url.pathname === "/api/users") return json({ users: [] });
    if (url.pathname === "/api/suppressions") return json({ rows: [{ email: "bounced.person@example.com", reason: "bounce", source: "ses", added_by: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: null }], next_cursor: null });
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [], core_error: null });
    if (url.pathname === "/api/brands") return json({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
    if (url.pathname === "/api/funnel") return json({ from: "2026-10-16T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z", rows: [] });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Leads and Suppressions routes", () => {
  const CLOSE = "ปิดรายละเอียด";
  const PANEL = "รายละเอียดลีด";

  it("deep links /leads/<id> to the list with the detail panel open and close returns to the list", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", `/leads/${LEAD_ID}`);
    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { level: 2, name: PANEL })).toBeTruthy();
    await screen.findByText("Postback Inspector");
    expect(requests).toContain(`/api/leads/${LEAD_ID}`);
    expect(container.textContent).toContain(APPLICANT_EMAIL);
    // The list stays beside the panel.
    expect(screen.getByRole("heading", { level: 1, name: LEADS_NAV })).toBeTruthy();
    expect(container.querySelector("table[aria-label='รายการลีด']")).toBeTruthy();
    expect(screen.getByTitle(LEAD_ID).getAttribute("aria-current")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: CLOSE }));
    expect(window.location.pathname).toBe("/leads");
    await waitFor(() => expect(screen.queryByRole("heading", { name: PANEL })).toBeNull());
    expect(container.textContent).not.toContain(APPLICANT_EMAIL);
    expect(menu().getByRole("link", { name: LEADS_MENU }).getAttribute("aria-current")).toBe("page");
    expect(tabs().getByRole("link", { name: LEADS_TAB }).getAttribute("aria-current")).toBe("page");
  });

  it("opens the panel from a list row and the close button returns to the list", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/leads");
    render(<App />);
    fireEvent.click(await screen.findByTitle(LEAD_ID));
    expect(window.location.pathname).toBe(`/leads/${LEAD_ID}`);
    await screen.findByText("Postback Inspector");
    const listRequests = requests.filter((r) => r.startsWith("/api/leads?")).length;
    fireEvent.click(screen.getByRole("button", { name: CLOSE }));
    expect(window.location.pathname).toBe("/leads");
    await waitFor(() => expect(screen.queryByText("Postback Inspector")).toBeNull());
    expect(screen.getByTitle(LEAD_ID)).toBeTruthy();
    // Opening and closing a lead never reloads the list.
    expect(requests.filter((r) => r.startsWith("/api/leads?")).length).toBe(listRequests);
  });

  it("keeps the list's filter query string while the panel opens and closes", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/leads?status=sold");
    render(<App />);
    fireEvent.click(await screen.findByTitle(LEAD_ID));
    expect(window.location.pathname).toBe(`/leads/${LEAD_ID}`);
    expect(window.location.search).toBe("?status=sold");
    await screen.findByText("Postback Inspector");
    fireEvent.click(screen.getByRole("button", { name: CLOSE }));
    expect(window.location.pathname).toBe("/leads");
    expect(window.location.search).toBe("?status=sold");
    await waitFor(() => expect(screen.queryByText("Postback Inspector")).toBeNull());
    expect(screen.getByTitle(LEAD_ID)).toBeTruthy();
  });

  it("shows the Leads menu item to both roles and the Suppressions tab only to an owner", async () => {
    window.history.replaceState(null, "", "/suppressions");
    const me = vi.spyOn(api, "me").mockResolvedValue(owner);
    const { unmount } = render(<App />);
    // Suppressions sits in the Settings section list.
    const sections = () => within(screen.getByRole("navigation", { name: "หมวดตั้งค่า" }));
    const sectionLabels = () => sections().getAllByRole("link").map((a) => a.textContent);
    await screen.findByRole("navigation", { name: "หมวดตั้งค่า" });
    const ownerTabs = sectionLabels();
    expect(ownerTabs.indexOf(SUPPRESSIONS_TAB)).toBe(ownerTabs.indexOf("รายชื่ออีเมล") + 1);
    expect(sections().getByRole("link", { name: SUPPRESSIONS_TAB }).getAttribute("href")).toBe("/suppressions");
    expect(sections().getByRole("link", { name: SUPPRESSIONS_TAB }).getAttribute("aria-current")).toBe("page");
    expect(menu().getByRole("link", { name: LEADS_MENU }).getAttribute("href")).toBe("/leads");
    unmount();

    me.mockResolvedValue(employee);
    render(<App />);
    await waitFor(() => expect(menu().getByRole("link", { name: LEADS_MENU })).toBeTruthy());
    expect(screen.queryByRole("link", { name: SUPPRESSIONS_TAB })).toBeNull();
  });

  it("renders the owner-only panel on /suppressions for an employee", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/suppressions");
    const { container } = render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: OWNER_ONLY })).toBeTruthy();
    // Let any effect that wrongly started a request settle before the assertions.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests.filter((r) => r.startsWith("/api/suppressions"))).toEqual([]);
    expect(container.textContent).not.toContain("bounced.person@example.com");
    expect(container.querySelector("main table, main input[type=search]")).toBeNull();
  });

  it("renders the suppression list on /suppressions for an owner", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/suppressions");
    const { container } = render(<App />);
    await screen.findByText("bounced.person@example.com");
    expect(container.textContent).not.toContain(OWNER_ONLY);
    expect(requests.filter((r) => r.startsWith("/api/suppressions"))).toEqual(["/api/suppressions"]);
  });
});
