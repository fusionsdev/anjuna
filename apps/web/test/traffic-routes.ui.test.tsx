import errorsFixture from "@anjuna/contracts/fixtures/admin/client-errors.response.json";
import trafficFixture from "@anjuna/contracts/fixtures/admin/traffic-report.response.json";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api, type Me } from "../src/client/api";
import { parseRoute, routePath } from "../src/client/router";
import { realtimeReport } from "./traffic-helpers";

const owner: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "u2", email: "staff@example.test", role: "employee" };
const TRAFFIC_TITLE = "ทราฟฟิก";
const ERRORS_TITLE = "ข้อผิดพลาดฝั่งเว็บ";
const TRAFFIC_TAB = "ทราฟฟิก";
const MONEY = "เงิน";

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
    if (url.pathname === "/api/traffic/realtime") return json(realtimeReport());
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
    expect(parseRoute("/realtime")).toEqual({ view: "realtime" });
    expect(routePath({ view: "realtime" })).toBe("/realtime");
    expect(parseRoute("/traffic")).toEqual({ view: "traffic" });
    expect(parseRoute("/errors")).toEqual({ view: "errors" });
    expect(parseRoute("/traffic/")).toEqual({ view: "traffic" });
    expect(routePath({ view: "traffic" })).toBe("/traffic");
    expect(routePath({ view: "errors" })).toBe("/errors");
  });

  it("the เงิน menu item holds the Traffic, live and Funnel tabs for an employee and an owner; Client errors moved to ระบบ", async () => {
    window.history.replaceState(null, "", "/funnel");
    const me = vi.spyOn(api, "me").mockResolvedValue(owner);
    const { unmount } = render(<App />);
    await screen.findByRole("navigation", { name: "หมวดย่อย" });
    expect(tabLabels()).toEqual([TRAFFIC_TAB, "เรียลไทม์", "ฟันเนล", "ลีด", "คอนเวอร์ชัน", "แคมเปญ"]);
    // The menu item opens the money page; every tab keeps its own URL.
    expect(menu().getByRole("link", { name: MONEY }).getAttribute("href")).toBe("/money");
    expect(tabs().getByRole("link", { name: "เรียลไทม์" }).getAttribute("href")).toBe("/realtime");
    expect(tabs().getByRole("link", { name: TRAFFIC_TAB }).getAttribute("href")).toBe("/traffic");
    expect(tabs().getByRole("link", { name: "ฟันเนล" }).getAttribute("href")).toBe("/funnel");
    unmount();

    me.mockResolvedValue(employee);
    render(<App />);
    await waitFor(() => expect(menu().getByRole("link", { name: MONEY })).toBeTruthy());
    expect(tabLabels()).toEqual([TRAFFIC_TAB, "เรียลไทม์", "ฟันเนล", "ลีด", "คอนเวอร์ชัน", "แคมเปญ"]);
  });

  it("opening /realtime renders the live tab with its page title, selected in the menu and in the tabs", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/realtime");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "เรียลไทม์" })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("เรียลไทม์ · เงิน · Control Panel"));
    expect(menu().getByRole("link", { name: MONEY }).getAttribute("aria-current")).toBe("page");
    expect(tabs().getByRole("link", { name: "เรียลไทม์" }).getAttribute("aria-current")).toBe("page");
    expect(tabs().getByRole("link", { name: TRAFFIC_TAB }).getAttribute("aria-current")).toBeNull();
  });

  it("opening /traffic renders the Traffic screen with its page title", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/traffic");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "ทราฟฟิก" })).toBeTruthy();
    // The title is set in an effect that can run after the heading appears.
    await waitFor(() => expect(document.title).toBe(`${TRAFFIC_TITLE} · เงิน · Control Panel`));
    expect(menu().getByRole("link", { name: MONEY }).getAttribute("aria-current")).toBe("page");
    expect(tabs().getByRole("link", { name: TRAFFIC_TAB }).getAttribute("aria-current")).toBe("page");
  });

  it("opening /errors renders the Client errors screen under ระบบ with its page title", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/errors");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "ข้อผิดพลาดฝั่งเว็บ" })).toBeTruthy();
    // The title is set in an effect that can run after the heading appears.
    await waitFor(() => expect(document.title).toBe(`${ERRORS_TITLE} · ระบบ · Control Panel`));
    expect(menu().getByRole("link", { name: "ระบบ" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("navigation", { name: "หมวดย่อย" })).toBeNull();
  });
});
