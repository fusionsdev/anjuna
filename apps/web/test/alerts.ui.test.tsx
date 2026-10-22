import alertsReport from "@anjuna/contracts/fixtures/admin/alerts.response.json";
import type { AlertsReportResponse } from "@anjuna/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { AlertsScreen } from "../src/client/screens/Alerts";

const healthy = alertsReport as AlertsReportResponse;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Alerts click_risk", () => {
  it("names each risky hostname with its high-risk share", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue({
      ...healthy,
      click_risk: {
        state: "alert",
        detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [{ hostname: "floatsme.com", visits: 200, high_risk: 62, rate: 0.31 }] },
      },
    });
    render(<AlertsScreen />);
    expect(await screen.findByText("floatsme.com: 31% ของคนเข้าเว็บได้คะแนนเสี่ยงสูง")).toBeTruthy();
  });

  it("says no hostname crossed the threshold when the report is healthy", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(healthy);
    render(<AlertsScreen />);
    expect(await screen.findByText("ไม่มีโดเมนที่คนเข้าเว็บได้คะแนนเสี่ยงสูงเกิน 20% ใน 24 ชม.")).toBeTruthy();
  });
});
