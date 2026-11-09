import errorsFixture from "@anjuna/contracts/fixtures/admin/client-errors.response.json";
import trafficFixture from "@anjuna/contracts/fixtures/admin/traffic-report.response.json";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api, type Me } from "../src/client/api";
import { parseRoute, routePath } from "../src/client/router";

const owner: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "u2", email: "staff@example.test", role: "employee" };
const TRAFFIC_TITLE = "ทราฟฟิก";
const ERRORS_TITLE = "ข้อผิดพลาดฝั่งเว็บ";
const TRAFFIC_TAB = "ทราฟฟิก";
const ERRORS_TAB = "ข้อผิดพลาดฝั่งเว็บ";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const menu = () => within(screen.getByRole("navigation", { name: "เมนูหลัก" }));
const tabs = () => within(screen.getByRole("navigation", { name: "หมวดย่อย" }));
const tabLabels = () => tabs().getAllByRole("link").map((a) => a.textContent);

beforeEach(() => {
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("alerts are not under test"));
  vi.spyOn(api, "navCounts").mockRejectedValue(new Error("counts are not under test"));
  vi.spyOn(api, "mePrefs").mockRejectedValue(new Error("prefs are not under test"));
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

  it("the Traffic menu item and its Traffic, Funnel and Client errors tabs show to an employee and an owner", async () => {
    window.history.replaceState(null, "", "/funnel");
    const me = vi.spyOn(api, "me").mockResolvedValue(owner);
    const { unmount } = render(<App />);
    await screen.findByRole("navigation", { name: "หมวดย่อย" });
    expect(tabLabels()).toEqual([TRAFFIC_TAB, "ฟันเนล", ERRORS_TAB]);
    expect(menu().getByRole("link", { name: TRAFFIC_TAB }).getAttribute("href")).toBe("/traffic");
    expect(tabs().getByRole("link", { name: TRAFFIC_TAB }).getAttribute("href")).toBe("/traffic");
    expect(tabs().getByRole("link", { name: ERRORS_TAB }).getAttribute("href")).toBe("/errors");
    unmount();

    me.mockResolvedValue(employee);
    render(<App />);
    await waitFor(() => expect(menu().getByRole("link", { name: TRAFFIC_TAB })).toBeTruthy());
    expect(tabLabels()).toEqual([TRAFFIC_TAB, "ฟันเนล", ERRORS_TAB]);
  });

  it("opening /traffic renders the Traffic screen with its page title", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/traffic");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "ทราฟฟิก" })).toBeTruthy();
    // The title is set in an effect that can run after the heading appears.
    await waitFor(() => expect(document.title).toBe(`${TRAFFIC_TITLE} · Control Panel`));
    expect(menu().getByRole("link", { name: TRAFFIC_TAB }).getAttribute("aria-current")).toBe("page");
    expect(tabs().getByRole("link", { name: TRAFFIC_TAB }).getAttribute("aria-current")).toBe("page");
  });

  it("opening /errors renders the Client errors screen with its page title", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/errors");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "ข้อผิดพลาดฝั่งเว็บ" })).toBeTruthy();
    // The title is set in an effect that can run after the heading appears.
    await waitFor(() => expect(document.title).toBe(`${ERRORS_TITLE} · Control Panel`));
    expect(menu().getByRole("link", { name: TRAFFIC_TAB }).getAttribute("aria-current")).toBe("page");
    expect(tabs().getByRole("link", { name: ERRORS_TAB }).getAttribute("aria-current")).toBe("page");
  });
});
