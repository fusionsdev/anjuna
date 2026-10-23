import alertsReport from "@anjuna/contracts/fixtures/admin/alerts.response.json";
import type { AlertsReportResponse } from "@anjuna/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { AlertsScreen } from "../src/client/screens/Alerts";

const healthy = alertsReport as AlertsReportResponse;

beforeEach(() => {
  vi.spyOn(api, "lifecycleBrands").mockResolvedValue({ brands: [{ brand_id: "brand-a", hostnames: ["lead.example"] }] as never });
  vi.spyOn(api, "brands").mockResolvedValue({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Alerts brand labels", () => {
  it("names brands by domain with the id in code in the postback, submit-error and reject lists", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue({
      ...healthy,
      brands_without_postbacks: { state: "alert", detail: { window_hours: 24, brands: [{ brand: "brand-a", leads: 4 }] } },
      submit_error_rate: { state: "alert", detail: { ...healthy.submit_error_rate.detail, samples: [{ brand: "brand-a", errors: 3, submits: 10, rate: 0.3 }] } },
      reject_rate: { state: "alert", detail: { ...healthy.reject_rate.detail, brands: [{ brand: "brand-a", rejected: 5, decided: 10, rate: 0.5 }] } },
    });
    render(<AlertsScreen />);
    await waitFor(() => expect(screen.getAllByText("lead.example")).toHaveLength(3));
    const ids = screen.getAllByText("brand-a");
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(id.tagName).toBe("CODE");
  });
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
