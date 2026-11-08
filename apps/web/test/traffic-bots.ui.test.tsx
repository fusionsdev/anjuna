import trafficFixture from "@anjuna/contracts/fixtures/admin/traffic-report.response.json";
import alertsFixture from "@anjuna/contracts/fixtures/admin/alerts.response.json";
import type { AlertsReportResponse } from "@anjuna/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrafficScreen } from "../src/client/screens/Traffic";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const alerts = (bot_hits?: AlertsReportResponse["bot_hits"]) => ({ ...alertsFixture, ...(bot_hits ? { bot_hits } : {}) });

function stub(alertsResponse: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, window.location.origin);
    if (url.pathname === "/api/traffic/report") return json(trafficFixture);
    if (url.pathname === "/api/alerts") return alertsResponse();
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "brand-a", hostnames: ["a.example"] }] });
    if (url.pathname === "/api/brands") return json({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
}

beforeEach(() => { window.history.replaceState(null, "", "/traffic"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("Traffic Googlebot and AdsBot strip", () => {
  it("shows per-brand counts and an AdsBot alert with the hour, in Thai, with no money", async () => {
    stub(() => json(alerts({ state: "alert", detail: { window_hours: 24,
      brands: [{ brand: "brand-a", googlebot: 7, adsbot: 5, other_bot: 2 }],
      adsbot_hours: [{ brand: "brand-a", hour: "2026-11-07T10:00:00Z", hits: 4 }] } })));
    render(<TrafficScreen />);
    const strip = await screen.findByRole("region", { name: "บอทของ Google" });
    const table = within(strip).getByRole("table", { name: "บอทของ Google" });
    expect(within(table).getAllByRole("cell").map((c) => c.textContent)).toEqual(expect.arrayContaining(["7", "5", "2"]));
    expect(within(strip).getByRole("alert").textContent).toContain("2026-11-07 10:00 UTC");
    expect(strip.textContent).not.toMatch(/\$|฿|USD|THB/);
  });

  it("shows no alert when only Googlebot visited", async () => {
    stub(() => json(alerts({ state: "ok", detail: { window_hours: 24,
      brands: [{ brand: "brand-a", googlebot: 3, adsbot: 0, other_bot: 0 }], adsbot_hours: [] } })));
    render(<TrafficScreen />);
    const strip = await screen.findByRole("region", { name: "บอทของ Google" });
    expect(within(strip).queryByRole("alert")).toBeNull();
  });

  it("hides the strip when core predates the counter or the call fails", async () => {
    stub(() => json(alerts()));
    const { unmount } = render(<TrafficScreen />);
    await screen.findByRole("table", { name: "เหตุการณ์ล่าสุด (Recent events)" });
    expect(screen.queryByRole("region", { name: "บอทของ Google" })).toBeNull();
    unmount();
    stub(() => json({ error: "x" }, 503));
    render(<TrafficScreen />);
    await screen.findByRole("table", { name: "เหตุการณ์ล่าสุด (Recent events)" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "บอทของ Google" })).toBeNull());
  });
});
