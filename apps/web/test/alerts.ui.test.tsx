import alertsReport from "@anjuna/contracts/fixtures/admin/alerts.response.json";
import type { AlertsReportResponse } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, type Me } from "../src/client/api";
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
    // Nothing is open when the report is healthy: the closed rows sit under ทั้งหมด.
    expect(await screen.findByText("ไม่มีการแจ้งเตือนในมุมมองนี้")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ทั้งหมด" }));
    expect(await screen.findByText("ไม่มีโดเมนที่คนเข้าเว็บได้คะแนนเสี่ยงสูงเกิน 20% ใน 24 ชม.")).toBeTruthy();
  });
});

const owner: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "u2", email: "staff@example.test", role: "employee" };
const noisy = (): AlertsReportResponse => ({
  ...healthy,
  brands_without_postbacks: { state: "alert", detail: { window_hours: 24, brands: [{ brand: "brand-a", leads: 4 }] } },
  reject_rate: { state: "warn", detail: { ...healthy.reject_rate.detail, brands: [{ brand: "brand-a", rejected: 15, decided: 100, rate: 0.15 }] } },
});

describe("Alerts list", () => {
  it("lists one row per brand with chips counting open, closed and all", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(noisy());
    render(<AlertsScreen />);
    const list = await screen.findByRole("region", { name: "รายการแจ้งเตือน" });
    const rows = within(list).getAllByRole("listitem");
    // Two open rows (postbacks, rejects). The healthy rules are closed.
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("แบรนด์ไม่มีโพสต์แบ็ก", { exact: false })).toBeTruthy();
    expect(within(rows[0]!).getByText("ผิดปกติ")).toBeTruthy();
    expect(within(rows[1]!).getByText("เตือน")).toBeTruthy();
    const chip = (name: string) => screen.getByRole("button", { name }).textContent!;
    expect(chip("เปิดอยู่")).toContain("2");
    expect(Number(chip("ทั้งหมด").replace(/\D/g, ""))).toBeGreaterThan(2);
    fireEvent.click(screen.getByRole("button", { name: "ปิดแล้ว" }));
    const closed = within(screen.getByRole("region", { name: "รายการแจ้งเตือน" })).getAllByRole("listitem");
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((li) => li.textContent!.includes("ปกติ"))).toBe(true);
  });

  it("acknowledges a row, calls core with the rule and brand key and moves the row out of the open list", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(noisy());
    const action = vi.spyOn(api, "alertAction").mockResolvedValue({ alert_key: "brands_without_postbacks:brand-a", state: "alert", first_seen: "2026-10-23T00:00:00.000Z", last_sent: null, acknowledged_by: "u1", acknowledged_at: "2026-10-23T01:00:00.000Z", closed_at: null, updated_at: "2026-10-23T01:00:00.000Z" });
    render(<AlertsScreen me={owner} />);
    const ack = await screen.findByRole("button", { name: /^รับทราบ แบรนด์ไม่มีโพสต์แบ็ก/ });
    fireEvent.click(ack);
    await waitFor(() => expect(action).toHaveBeenCalledWith("brands_without_postbacks:brand-a", "ack"));
    expect(await screen.findByText("รับทราบการแจ้งเตือนแล้ว")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^รับทราบ แบรนด์ไม่มีโพสต์แบ็ก/ })).toBeNull();
    expect(screen.getByRole("button", { name: "เปิดอยู่" }).textContent).toContain("1");
  });

  it("keeps the row open and says so when core no longer knows the alert", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(noisy());
    const action = vi.spyOn(api, "alertAction").mockRejectedValue(new ApiError(404, { error: "request_failed" }));
    render(<AlertsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: /^ปิด อัตราปฏิเสธ/ }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("reject_rate:brand-a", "close"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ไม่พบการแจ้งเตือนนี้");
    expect(screen.getByRole("button", { name: /^ปิด อัตราปฏิเสธ/ })).toBeTruthy();
  });

  it("shows the rules card with every switch disabled and a tooltip", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(healthy);
    render(<AlertsScreen />);
    const card = await screen.findByRole("region", { name: "กฎการแจ้งเตือน" });
    const switches = within(card).getAllByRole("switch") as HTMLButtonElement[];
    expect(switches.length).toBeGreaterThanOrEqual(5);
    for (const sw of switches) {
      expect(sw.disabled).toBe(true);
      expect(sw.title).toContain("ยังไม่มี API กฎการแจ้งเตือน");
    }
  });
});

describe("Alerts send history", () => {
  const rows = [
    { id: "n1", channel: "telegram" as const, target: "123", alert_key: "reject_rate:brand-a", status: "failed" as const, response_code: 429, body_hash: "a".repeat(64), sent_at: "2026-10-23T09:00:00.000Z" },
    { id: "n2", channel: "telegram" as const, target: "123", alert_key: "digest:2026-10-23", status: "sent" as const, response_code: 200, body_hash: "b".repeat(64), sent_at: "2026-10-23T08:00:00.000Z" },
  ];

  it("lists the log with status chips and offers ส่งใหม่ only on a failed row to an owner", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(healthy);
    vi.spyOn(api, "alertsLog").mockResolvedValue(rows);
    render(<AlertsScreen me={owner} />);
    fireEvent.click(screen.getByRole("button", { name: "ประวัติการส่ง" }));
    const table = await screen.findByRole("table", { name: "ประวัติการส่ง" });
    const body = within(table).getAllByRole("row").slice(1);
    expect(body).toHaveLength(2);
    expect(within(body[0]!).getByText("ล้มเหลว 429")).toBeTruthy();
    expect(within(body[0]!).getByText("อัตราปฏิเสธ")).toBeTruthy();
    expect(within(body[0]!).getByRole("button", { name: "ส่งใหม่ อัตราปฏิเสธ" })).toBeTruthy();
    expect(within(body[1]!).getByText("ส่งแล้ว")).toBeTruthy();
    expect(within(body[1]!).getByText("สรุปรายวัน 2026-10-23")).toBeTruthy();
    expect(within(body[1]!).queryByRole("button")).toBeNull();
  });

  it("sends a failed row again, reloads the log and reports the result", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(healthy);
    const log = vi.spyOn(api, "alertsLog").mockResolvedValueOnce(rows).mockResolvedValueOnce([{ ...rows[0]!, status: "sent", response_code: 200 }, rows[1]!]);
    const retry = vi.spyOn(api, "retryAlertSend").mockResolvedValue({ status: "sent", response_code: 200 });
    render(<AlertsScreen me={owner} />);
    fireEvent.click(screen.getByRole("button", { name: "ประวัติการส่ง" }));
    fireEvent.click(await screen.findByRole("button", { name: "ส่งใหม่ อัตราปฏิเสธ" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("n1"));
    expect(await screen.findByText("ส่งใหม่แล้ว")).toBeTruthy();
    await waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "ส่งใหม่ อัตราปฏิเสธ" })).toBeNull();
  });

  it("hides ส่งใหม่ from an employee", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(healthy);
    vi.spyOn(api, "alertsLog").mockResolvedValue(rows);
    render(<AlertsScreen me={employee} />);
    fireEvent.click(screen.getByRole("button", { name: "ประวัติการส่ง" }));
    await screen.findByRole("table", { name: "ประวัติการส่ง" });
    expect(screen.queryByRole("button", { name: /^ส่งใหม่/ })).toBeNull();
  });
});
