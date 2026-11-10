import alertsReport from "@anjuna/contracts/fixtures/admin/alerts.response.json";
import type { AlertsReportResponse } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, type Me } from "../src/client/api";
import { hydrateAlertStates, resetAlertSession } from "../src/client/alerts-session";
import { AlertsScreen } from "../src/client/screens/Alerts";

const healthy = alertsReport as AlertsReportResponse;

beforeEach(() => {
  vi.spyOn(api, "lifecycleBrands").mockResolvedValue({ brands: [{ brand_id: "brand-a", hostnames: ["lead.example"] }] as never });
  vi.spyOn(api, "brands").mockResolvedValue({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
  // Core has stored no acknowledge or close yet, unless a test says otherwise.
  vi.spyOn(api, "alertStates").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  resetAlertSession();
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
    // The numbers the page showed before the redesign: high-risk visitors out of all visitors.
    expect(await screen.findByText("floatsme.com · เสี่ยงสูง 62 จาก 200 คน (31%)")).toBeTruthy();
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
    // Two open rows (postbacks, rejects). The healthy rules sit only under ทั้งหมด.
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("แบรนด์ไม่มีโพสต์แบ็ก", { exact: false })).toBeTruthy();
    expect(within(rows[0]!).getByText("ผิดปกติ")).toBeTruthy();
    expect(within(rows[1]!).getByText("เตือน")).toBeTruthy();
    const chip = (name: string) => screen.getByRole("button", { name }).textContent!;
    expect(chip("เปิดอยู่")).toContain("2");
    expect(Number(chip("ทั้งหมด").replace(/\D/g, ""))).toBeGreaterThan(2);
    // Nothing was closed by anyone, so ปิดแล้ว is empty: a healthy rule is not a closed alert.
    expect(chip("ปิดแล้ว")).toContain("0");
    fireEvent.click(screen.getByRole("button", { name: "ปิดแล้ว" }));
    expect(screen.getByText("ไม่มีการแจ้งเตือนในมุมมองนี้")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ทั้งหมด" }));
    const all = within(screen.getByRole("region", { name: "รายการแจ้งเตือน" })).getAllByRole("listitem");
    expect(all.length).toBeGreaterThan(2);
    expect(all.slice(2).every((li) => li.textContent!.includes("ปกติ") && !li.textContent!.includes("ปิดแล้ว"))).toBe(true);
  });

  it("shows a healthy report as zero open and zero closed", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(healthy);
    render(<AlertsScreen />);
    await screen.findByRole("region", { name: "รายการแจ้งเตือน" });
    expect(screen.getByRole("button", { name: "เปิดอยู่" }).textContent).toContain("0");
    expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("0");
  });

  const stateRow = (key: string, over: Record<string, string | null> = {}) => ({
    alert_key: key, state: "alert" as const, first_seen: "2026-10-23T00:00:00.000Z", last_sent: null, acknowledged_by: null, acknowledged_at: null, closed_at: null, updated_at: "2026-10-23T00:00:00.000Z", ...over,
  });
  const ackedRow = (key: string) => stateRow(key, { acknowledged_by: "u1", acknowledged_at: "2026-10-23T01:00:00.000Z" });
  const closedRow = (key: string) => stateRow(key, { closed_at: "2026-10-23T02:00:00.000Z" });
  const ackName = /^รับทราบ แบรนด์ไม่มีโพสต์แบ็ก/;
  const closeName = /^ปิด แบรนด์ไม่มีโพสต์แบ็ก/;

  it("acknowledges a row, calls core with the rule and brand key and keeps the row open with a รับทราบแล้ว chip and a working ปิด", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(noisy());
    const action = vi.spyOn(api, "alertAction").mockResolvedValue(ackedRow("brands_without_postbacks:brand-a"));
    const changed = vi.fn();
    render(<AlertsScreen me={owner} onChanged={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: ackName }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("brands_without_postbacks:brand-a", "ack"));
    expect(await screen.findByText("รับทราบการแจ้งเตือนแล้ว")).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: ackName })).toBeNull();
    const row = screen.getByRole("button", { name: closeName }).closest("li")!;
    expect(within(row).getByText("รับทราบแล้ว")).toBeTruthy();
    // Acknowledged is not closed: the row stays under เปิดอยู่ and ปิดแล้ว stays empty.
    expect(screen.getByRole("button", { name: "เปิดอยู่" }).textContent).toContain("2");
    expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("0");
  });

  it("closes a row with POST close, moves it to ปิดแล้ว with its close time and refreshes the counts", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(noisy());
    const action = vi.spyOn(api, "alertAction").mockResolvedValue(closedRow("brands_without_postbacks:brand-a"));
    const changed = vi.fn();
    render(<AlertsScreen me={owner} onChanged={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: closeName }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("brands_without_postbacks:brand-a", "close"));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "เปิดอยู่" }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("1");
    fireEvent.click(screen.getByRole("button", { name: "ปิดแล้ว" }));
    const closed = within(screen.getByRole("region", { name: "รายการแจ้งเตือน" })).getAllByRole("listitem");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.textContent).toContain("แบรนด์ไม่มีโพสต์แบ็ก");
    expect(closed[0]!.textContent).toContain("ปิดเมื่อ");
    expect(within(closed[0]!).queryByRole("button")).toBeNull();
  });

  it("keeps what the owner did after a switch to ประวัติการส่ง and after the screen mounts again", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue(noisy());
    vi.spyOn(api, "alertsLog").mockResolvedValue([]);
    vi.spyOn(api, "alertAction").mockImplementation(async (key, act) => (act === "ack" ? ackedRow(key) : closedRow(key)));
    const first = render(<AlertsScreen me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: ackName }));
    await screen.findByText("รับทราบการแจ้งเตือนแล้ว");
    fireEvent.click(screen.getByRole("button", { name: /^ปิด อัตราปฏิเสธ/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("1"));
    // Tab round trip.
    fireEvent.click(screen.getByRole("button", { name: "ประวัติการส่ง" }));
    await screen.findByText("ยังไม่มีการส่งแจ้งเตือน");
    fireEvent.click(screen.getByRole("button", { name: "การแจ้งเตือน" }));
    expect((await screen.findByRole("button", { name: closeName })).closest("li")!.textContent).toContain("รับทราบแล้ว");
    expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("1");
    // A new mount of the screen.
    first.unmount();
    render(<AlertsScreen me={owner} />);
    expect((await screen.findByRole("button", { name: closeName })).closest("li")!.textContent).toContain("รับทราบแล้ว");
    expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("1");
  });

  describe("after a fresh page load", () => {
    // A fake core: POST ack/close store a row under the key, GET /api/alerts/state lists every stored row. The real api client runs.
    let stored: Map<string, ReturnType<typeof stateRow>>;
    let requests: string[];
    let pageRequests: string[];
    beforeEach(() => {
      pageRequests = [];
      (api.alertStates as unknown as { mockRestore: () => void }).mockRestore();
      stored = new Map();
      requests = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        requests.push(`${method} ${input}`);
        const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        if (method === "GET" && input.startsWith("/api/alerts/state")) {
          const query = new URL(input, "http://panel.test").searchParams;
          pageRequests.push(input);
          const ordered = [...stored.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.alert_key.localeCompare(b.alert_key));
          const from = query.get("cursor") === null ? 0 : Number(query.get("cursor"));
          const size = Number(query.get("limit") ?? "200");
          const rows = ordered.slice(from, from + size);
          return ok({ rows, next_cursor: from + size < ordered.length ? String(from + size) : null });
        }
        const action = /^\/api\/alerts\/([^/]+)\/(ack|close)$/.exec(input);
        if (method === "POST" && action) {
          const key = decodeURIComponent(action[1]!);
          const row = action[2] === "ack" ? ackedRow(key) : closedRow(key);
          stored.set(key, { ...stored.get(key), ...row, ...(action[2] === "ack" ? {} : { acknowledged_at: stored.get(key)?.acknowledged_at ?? null }) });
          return ok(stored.get(key));
        }
        throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
      }));
    });
    afterEach(() => vi.unstubAllGlobals());

    /** The browser reloads: the screen unmounts and the in-memory store starts empty. */
    const reload = (view: { unmount: () => void }) => { view.unmount(); resetAlertSession(); };

    it("shows รับทราบแล้ว again after an acknowledge was POSTed and the page loaded fresh", async () => {
      vi.spyOn(api, "alerts").mockResolvedValue(noisy());
      const first = render(<AlertsScreen me={owner} />);
      fireEvent.click(await screen.findByRole("button", { name: ackName }));
      await screen.findByText("รับทราบการแจ้งเตือนแล้ว");
      expect(stored.get("brands_without_postbacks:brand-a")?.acknowledged_at).not.toBeNull();
      reload(first);
      render(<AlertsScreen me={owner} />);
      const row = (await screen.findByRole("button", { name: closeName })).closest("li")!;
      expect(within(row).getByText("รับทราบแล้ว")).toBeTruthy();
      expect(within(row).queryByRole("button", { name: ackName })).toBeNull();
      expect(screen.getByRole("button", { name: "เปิดอยู่" }).textContent).toContain("2");
      expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("0");
      // One read per page load: the first page and the fresh one.
      expect(requests.filter((r) => r.startsWith("GET /api/alerts/state"))).toHaveLength(2);
    });

    it("keeps a closed alert in ปิดแล้ว with its close time after it was POSTed and the page loaded fresh", async () => {
      vi.spyOn(api, "alerts").mockResolvedValue(noisy());
      const first = render(<AlertsScreen me={owner} />);
      fireEvent.click(await screen.findByRole("button", { name: closeName }));
      await waitFor(() => expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("1"));
      expect(stored.get("brands_without_postbacks:brand-a")?.closed_at).not.toBeNull();
      reload(first);
      render(<AlertsScreen me={owner} />);
      await screen.findByRole("region", { name: "รายการแจ้งเตือน" });
      expect(screen.getByRole("button", { name: "เปิดอยู่" }).textContent).toContain("1");
      expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("1");
      expect(screen.queryByRole("button", { name: closeName })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "ปิดแล้ว" }));
      const closed = within(screen.getByRole("region", { name: "รายการแจ้งเตือน" })).getAllByRole("listitem");
      expect(closed).toHaveLength(1);
      expect(closed[0]!.textContent).toContain("แบรนด์ไม่มีโพสต์แบ็ก");
      expect(closed[0]!.textContent).toContain("ปิดเมื่อ");
    });

    it("reads every page of stored states: with 501 states the oldest acknowledge and close come back after a store reset and a reload", async () => {
      // 501 stored states. The two the screen needs (an acknowledge and a close) are the OLDEST two, so they sit on the second page.
      const oldest = "2026-01-01T00:00:00.000Z";
      stored.set("brands_without_postbacks:brand-a", { ...ackedRow("brands_without_postbacks:brand-a"), updated_at: oldest });
      stored.set("reject_rate:brand-a", { ...closedRow("reject_rate:brand-a"), updated_at: "2026-01-01T00:00:01.000Z" });
      for (let i = 0; i < 499; i += 1) {
        const key = `click_risk:brand-${String(i).padStart(3, "0")}`;
        stored.set(key, { ...closedRow(key), updated_at: new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString() });
      }
      expect(stored.size).toBe(501);
      vi.spyOn(api, "alerts").mockResolvedValue(noisy());
      const first = render(<AlertsScreen me={owner} />);
      await screen.findByRole("region", { name: "รายการแจ้งเตือน" });
      // Reload: the unmount and an empty store, then a fresh read.
      reload(first);
      pageRequests = [];
      render(<AlertsScreen me={owner} />);
      const postbackRow = (await screen.findByRole("button", { name: closeName })).closest("li")!;
      // The 501st state (the oldest, an acknowledge) is back: รับทราบแล้ว shows and the ack button is gone.
      expect(within(postbackRow).getByText("รับทราบแล้ว")).toBeTruthy();
      expect(within(postbackRow).queryByRole("button", { name: ackName })).toBeNull();
      // The second oldest, a close, is back too: the reject rate row left เปิดอยู่, so one open row stays.
      expect(screen.getByRole("button", { name: "เปิดอยู่" }).textContent).toContain("1");
      // 499 other closed rows plus the reject-rate close: 500 under ปิดแล้ว (click_risk rows have no incident in this report).
      expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("500");
      // Two requests: the first page (500 rows) and the one the cursor pointed to (1 row).
      expect(pageRequests).toHaveLength(2);
      expect(pageRequests[0]).toBe("/api/alerts/state?limit=500");
      expect(pageRequests[1]).toBe("/api/alerts/state?limit=500&cursor=500");
    });

    it("says the stored states could not load when core keeps returning the same cursor", async () => {
      vi.spyOn(api, "alerts").mockResolvedValue(noisy());
      vi.mocked(fetch).mockImplementation((async (input: string) => {
        if (input.startsWith("/api/alerts/state")) return new Response(JSON.stringify({ rows: [], next_cursor: "stuck" }), { status: 200, headers: { "content-type": "application/json" } });
        throw new Error("Unexpected test HTTP request: " + input);
      }) as typeof fetch);
      render(<AlertsScreen me={owner} />);
      expect((await screen.findByRole("alert")).textContent).toContain("โหลดสถานะรับทราบและปิดที่บันทึกไว้ไม่ได้");
      // The report still shows, with its two open rows.
      expect(screen.getByRole("button", { name: "เปิดอยู่" }).textContent).toContain("2");
    });

    it("holds the list back until the stored states arrive, so an acknowledged row never flashes as open", async () => {
      vi.spyOn(api, "alerts").mockResolvedValue(noisy());
      let release!: (rows: ReturnType<typeof stateRow>[]) => void;
      vi.spyOn(api, "alertStates").mockReturnValue(new Promise((resolve) => { release = resolve; }));
      render(<AlertsScreen me={owner} />);
      await waitFor(() => expect(api.alerts).toHaveBeenCalled());
      expect(screen.queryByRole("region", { name: "รายการแจ้งเตือน" })).toBeNull();
      release([ackedRow("brands_without_postbacks:brand-a")]);
      const row = (await screen.findByRole("button", { name: closeName })).closest("li")!;
      expect(within(row).getByText("รับทราบแล้ว")).toBeTruthy();
    });

    it("says the stored states could not load, keeps the report and loads them on retry", async () => {
      vi.spyOn(api, "alerts").mockResolvedValue(noisy());
      const read = vi.spyOn(api, "alertStates").mockRejectedValueOnce(new ApiError(502, null)).mockResolvedValue([ackedRow("brands_without_postbacks:brand-a")]);
      render(<AlertsScreen me={owner} />);
      expect((await screen.findByRole("alert")).textContent).toContain("โหลดสถานะรับทราบและปิดที่บันทึกไว้ไม่ได้");
      expect(screen.getByRole("button", { name: "เปิดอยู่" }).textContent).toContain("2");
      fireEvent.click(screen.getByRole("button", { name: "ลองใหม่" }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText(/โหลดสถานะรับทราบและปิดที่บันทึกไว้ไม่ได้/)).toBeNull());
      expect((await screen.findByRole("button", { name: closeName })).closest("li")!.textContent).toContain("รับทราบแล้ว");
    });

    it("keeps a row already held when the stored list carries an older copy of it", () => {
      hydrateAlertStates([closedRow("reject_rate:brand-a")]);
      hydrateAlertStates([stateRow("reject_rate:brand-a", { updated_at: "2026-10-22T00:00:00.000Z" })]);
      vi.spyOn(api, "alerts").mockResolvedValue(noisy());
      render(<AlertsScreen me={owner} />);
      return waitFor(() => expect(screen.getByRole("button", { name: "ปิดแล้ว" }).textContent).toContain("1"));
    });
  });

  it("shows disabled รับทราบ and ปิด with the reason on a row the report gives no brand for, and keeps a matched hostname enabled", async () => {
    vi.spyOn(api, "alerts").mockResolvedValue({
      ...healthy,
      conversion_stalled: { state: "alert", detail: { max_hours: 6, stuck_count: 5, oldest_created_at: "2026-10-22T00:00:00.000Z" } },
      click_risk: {
        state: "alert",
        detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [{ hostname: "unknown.example", visits: 100, high_risk: 40, rate: 0.4 }, { hostname: "lead.example", visits: 80, high_risk: 30, rate: 0.375 }] },
      },
    });
    const action = vi.spyOn(api, "alertAction").mockResolvedValue(ackedRow("click_risk:brand-a"));
    render(<AlertsScreen me={owner} />);
    const list = await screen.findByRole("region", { name: "รายการแจ้งเตือน" });
    const stalled = within(list).getByText("คอนเวอร์ชันค้าง", { selector: "p.alert-title" }).closest("li")!;
    for (const name of [/^รับทราบ คอนเวอร์ชันค้าง/, /^ปิด คอนเวอร์ชันค้าง/]) {
      const button = within(stalled).getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toContain("รายงานไม่ระบุแบรนด์");
    }
    const unknown = screen.getByText(/^unknown\.example/).closest("li")!;
    expect((within(unknown).getByRole("button", { name: /^รับทราบ/ }) as HTMLButtonElement).disabled).toBe(true);
    const matched = screen.getByText(/^lead\.example/).closest("li")!;
    const enabled = within(matched).getByRole("button", { name: /^รับทราบ/ }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    await waitFor(() => expect(action).toHaveBeenCalledWith("click_risk:brand-a", "ack"));
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
