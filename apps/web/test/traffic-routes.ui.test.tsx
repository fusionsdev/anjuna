import errorsFixture from "@anjuna/contracts/fixtures/admin/client-errors.response.json";
import trafficFixture from "@anjuna/contracts/fixtures/admin/traffic-report.response.json";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api, type Me } from "../src/client/api";
import { parseRoute, routePath } from "../src/client/router";

const owner: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "u2", email: "staff@example.test", role: "employee" };
const TRAFFIC_NAV = "ทราฟฟิก (Traffic)";
const ERRORS_NAV = "ข้อผิดพลาดฝั่งเว็บ (Client errors)";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const navLabels = () => within(screen.getByRole("navigation", { name: "เมนูหลัก" })).getAllByRole("link").map((a) => a.textContent);

beforeEach(() => {
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("alerts are not under test"));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, window.location.origin);
    if (url.pathname === "/api/traffic/report") return json(trafficFixture);
    if (url.pathname === "/api/client-errors") return json(errorsFixture);
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [] });
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

describe("Traffic and Client errors routes", () => {
  it("parseRoute reads /traffic and /errors, and routePath writes them back", () => {
    expect(parseRoute("/traffic")).toEqual({ view: "traffic" });
    expect(parseRoute("/errors")).toEqual({ view: "errors" });
    expect(parseRoute("/traffic/")).toEqual({ view: "traffic" });
    expect(routePath({ view: "traffic" })).toBe("/traffic");
    expect(routePath({ view: "errors" })).toBe("/errors");
  });

  it("the sidebar shows Traffic and Client errors to an employee and an owner, after Funnel", async () => {
    window.history.replaceState(null, "", "/funnel");
    const me = vi.spyOn(api, "me").mockResolvedValue(owner);
    const { unmount } = render(<App />);
    await screen.findByRole("navigation", { name: "เมนูหลัก" });
    const ownerNav = navLabels();
    const funnel = ownerNav.findIndex((l) => l!.startsWith("ฟันเนล"));
    expect(ownerNav.slice(funnel + 1, funnel + 4)).toEqual([TRAFFIC_NAV, ERRORS_NAV, "ลีด (Leads)"]);
    expect(screen.getByRole("link", { name: TRAFFIC_NAV }).getAttribute("href")).toBe("/traffic");
    expect(screen.getByRole("link", { name: ERRORS_NAV }).getAttribute("href")).toBe("/errors");
    unmount();

    me.mockResolvedValue(employee);
    render(<App />);
    await waitFor(() => expect(screen.getByRole("link", { name: TRAFFIC_NAV })).toBeTruthy());
    const employeeNav = navLabels();
    const employeeFunnel = employeeNav.findIndex((l) => l!.startsWith("ฟันเนล"));
    expect(employeeNav.slice(employeeFunnel + 1, employeeFunnel + 3)).toEqual([TRAFFIC_NAV, ERRORS_NAV]);
    expect(ownerNav).toContain("ผู้ใช้");
    expect(employeeNav).not.toContain("ผู้ใช้");
  });

  it("opening /traffic renders the Traffic screen with its page title", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/traffic");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "ทราฟฟิก" })).toBeTruthy();
    expect(document.title).toBe(`${TRAFFIC_NAV} · Control Panel`);
    expect(document.querySelector(".topbar-title")?.textContent).toBe(TRAFFIC_NAV);
    expect(screen.getByRole("link", { name: TRAFFIC_NAV }).getAttribute("aria-current")).toBe("page");
  });

  it("opening /errors renders the Client errors screen with its page title", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/errors");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "ข้อผิดพลาดฝั่งเว็บ" })).toBeTruthy();
    expect(document.title).toBe(`${ERRORS_NAV} · Control Panel`);
    expect(document.querySelector(".topbar-title")?.textContent).toBe(ERRORS_NAV);
    expect(screen.getByRole("link", { name: ERRORS_NAV }).getAttribute("aria-current")).toBe("page");
  });
});
