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
const LEADS_NAV = "ลีด (Leads)";
const SUPPRESSIONS_NAV = "อีเมลที่บล็อก (Suppressions)";
const OWNER_ONLY = "สำหรับ Owner เท่านั้น (Owner only)";

let requests: string[];
const json = (body: unknown, status = 200) => Response.json(body, { status });
const back = () => act(async () => {
  window.history.back();
  await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
});
const navLabels = () => within(screen.getByRole("navigation", { name: "เมนูหลัก" })).getAllByRole("link").map((a) => a.textContent);

beforeEach(() => {
  requests = [];
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("Unavailable"));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, "https://app.test");
    if (url.pathname === "/api/leads") return json(leadsFixture as LeadsResponse);
    if (url.pathname === `/api/leads/${LEAD_ID}`) return json(ownerLeadFixture);
    if (url.pathname === "/api/suppressions") return json({ rows: [{ email: "bounced.person@example.com", reason: "bounce", source: "ses", created_at: "2026-10-01T00:00:00.000Z", updated_at: null }], next_cursor: null });
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
  it("deep links /leads/<id> to the detail screen and back returns to the list", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/funnel");
    window.history.pushState(null, "", "/leads");
    window.history.pushState(null, "", `/leads/${LEAD_ID}`);
    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "รายละเอียดลีด (Lead detail)" })).toBeTruthy();
    await screen.findByText("Postback Inspector");
    expect(requests).toContain(`/api/leads/${LEAD_ID}`);
    expect(container.textContent).toContain(APPLICANT_EMAIL);
    expect(container.textContent).toContain(LEAD_ID);

    await back();
    expect(window.location.pathname).toBe("/leads");
    expect(await screen.findByRole("heading", { level: 1, name: LEADS_NAV })).toBeTruthy();
    await screen.findByTitle(LEAD_ID);
    expect(screen.queryByRole("heading", { name: "รายละเอียดลีด (Lead detail)" })).toBeNull();
    expect(container.textContent).not.toContain(APPLICANT_EMAIL);
    expect(screen.getByRole("link", { name: LEADS_NAV }).getAttribute("aria-current")).toBe("page");
  });

  it("opens the detail from a list row and the Back button returns to the list", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/leads");
    render(<App />);
    fireEvent.click(await screen.findByTitle(LEAD_ID));
    expect(window.location.pathname).toBe(`/leads/${LEAD_ID}`);
    await screen.findByText("Postback Inspector");
    fireEvent.click(screen.getByRole("button", { name: "← กลับรายการลีด (Back to leads)" }));
    expect(window.location.pathname).toBe("/leads");
    await screen.findByTitle(LEAD_ID);
    expect(screen.queryByText("Postback Inspector")).toBeNull();
  });

  it("keeps the list's filter query string when the Back button returns to the list", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/leads?status=sold");
    render(<App />);
    fireEvent.click(await screen.findByTitle(LEAD_ID));
    expect(window.location.pathname).toBe(`/leads/${LEAD_ID}`);
    await screen.findByText("Postback Inspector");
    fireEvent.click(screen.getByRole("button", { name: "← กลับรายการลีด (Back to leads)" }));
    expect(window.location.pathname).toBe("/leads");
    expect(window.location.search).toBe("?status=sold");
    await screen.findByTitle(LEAD_ID);
    expect(screen.queryByText("Postback Inspector")).toBeNull();
  });

  it("shows the Leads nav item to both roles and Suppressions only to an owner", async () => {
    window.history.replaceState(null, "", "/funnel");
    const me = vi.spyOn(api, "me").mockResolvedValue(owner);
    const { unmount } = render(<App />);
    await screen.findByRole("navigation", { name: "เมนูหลัก" });
    const ownerNav = navLabels();
    expect(ownerNav.indexOf(LEADS_NAV)).toBe(ownerNav.findIndex((l) => l!.startsWith("ฟันเนล")) + 1);
    expect(ownerNav.indexOf(SUPPRESSIONS_NAV)).toBe(ownerNav.findIndex((l) => l!.startsWith("รายชื่ออีเมล")) + 1);
    expect(screen.getByRole("link", { name: SUPPRESSIONS_NAV }).getAttribute("href")).toBe("/suppressions");
    expect(screen.getByRole("link", { name: LEADS_NAV }).getAttribute("href")).toBe("/leads");
    unmount();

    me.mockResolvedValue(employee);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("link", { name: LEADS_NAV })).toBeTruthy());
    const employeeNav = navLabels();
    expect(employeeNav).toContain(LEADS_NAV);
    expect(employeeNav).not.toContain(SUPPRESSIONS_NAV);
    expect(screen.queryByRole("link", { name: SUPPRESSIONS_NAV })).toBeNull();
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
