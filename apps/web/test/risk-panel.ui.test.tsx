import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrafficRiskResponse } from "@anjuna/contracts";
import { RiskPanel } from "../src/client/screens/RiskPanel";

const report: TrafficRiskResponse = {
  signals: [
    { id: "known_bot_ua", label: "เครื่องดูเป็นบอท (user agent)", weight: 50, count: 88 },
    { id: "timezone_geo_mismatch", label: "เขตเวลาไม่ตรงกับประเทศ", weight: 20, count: 141 },
    { id: "rapid_repeat_session", label: "คลิกซ้ำถี่เกิน 25 ครั้ง/ชม.", weight: 30, count: 63 },
  ],
  domains: [
    { hostname: "floatsme.com", visits: 687, high_risk: 212 },
    { hostname: "creditsgene.com", visits: 902, high_risk: 61 },
  ],
  hours: Array.from({ length: 24 }, (_, hour) => ({ hour, visits: 0, high_risk: 0 })),
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("RiskPanel", () => {
  it("shows the observe-only label, each signal with its weight and the high-risk share per domain", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(report));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<RiskPanel period="30d" />);
    await screen.findByText("floatsme.com");
    expect(fetcher).toHaveBeenCalledWith("/api/traffic/risk?period=30d", expect.objectContaining({ method: "GET" }));
    expect(screen.getByText("โหมดเก็บข้อมูล ไม่บล็อกใคร")).toBeTruthy();
    const bot = container.querySelector('[data-signal="known_bot_ua"]') as HTMLElement;
    expect(within(bot).getByText("น้ำหนัก 50 คะแนน")).toBeTruthy();
    expect(within(bot).getByText("88")).toBeTruthy();
    const floats = container.querySelector('[data-hostname="floatsme.com"]') as HTMLElement;
    expect(within(floats).getByText("212 จาก 687 คน")).toBeTruthy();
    expect(within(floats).getByText("31%").className).toBe("pill p-warn");
    const credits = container.querySelector('[data-hostname="creditsgene.com"]') as HTMLElement;
    expect(within(credits).getByText("7%").className).toBe("pill p-mute");
    expect(screen.queryByText("ส่งออกรายการเพื่อขอเงินคืน")).toBeNull();
  });

  it("gives the owner a CSV export link for the same period", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(report)));
    render(<RiskPanel period="today" canExport />);
    const link = await screen.findByText("ส่งออกรายการเพื่อขอเงินคืน");
    expect(link.getAttribute("href")).toBe("/api/traffic/risk/export?period=today");
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("shows an error instead of numbers when the report fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "bad_gateway", message: "core unreachable" }, { status: 502 })));
    render(<RiskPanel />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("สัญญาณที่เจอ")).toBeNull();
  });
});
