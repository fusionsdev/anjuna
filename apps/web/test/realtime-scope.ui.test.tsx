import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeTab } from "../src/client/traffic/RealtimeTab";
import { MockEventSource, realtimeReport } from "./traffic-helpers";

// The brand scope hides brand-b. Only the pieces RealtimeTab reads are provided.
let visible: string[] = [];
vi.mock("../src/client/useBrandScope", () => ({
  useBrandScope: () => ({
    hidesBrands: true,
    list: [{ brand: { brand_id: "brand-a" }, scope: { id: "brand-a" } }, { brand: { brand_id: "brand-b" }, scope: { id: "brand-b" } }],
    isVisible: (scope: { id: string }) => visible.includes(scope.id),
    inScopeId: (id: string) => visible.includes(id),
  }),
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
let requests: string[];

beforeEach(() => {
  requests = [];
  visible = ["brand-a"];
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  window.history.replaceState(null, "", "/realtime");
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, window.location.origin);
    if (url.pathname === "/api/traffic/realtime") {
      return json(realtimeReport({
        recent: [
          { ...realtimeReport().recent[0]!, event_type: "visible_row", brand: "brand-a" },
          { ...realtimeReport().recent[0]!, event_type: "hidden_row", brand: "brand-b" },
        ],
      }));
    }
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "brand-a", hostnames: ["a.example"] }, { brand_id: "brand-b", hostnames: ["b.example"] }] });
    if (url.pathname === "/api/brands") return json({ brands: [], generated_at: "2026-11-10T00:00:00.000Z" });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Realtime tab with a brand scope that hides brands", () => {
  it("asks the report and the stream for the visible brands only and hides the other brand's rows", async () => {
    render(<RealtimeTab />);
    await screen.findByRole("region", { name: "ตัวเลขสำคัญ" });
    expect(requests.find((r) => r.startsWith("/api/traffic/realtime"))).toBe("/api/traffic/realtime?period=24h&brand=brand-a");
    expect(MockEventSource.last().url).toBe("/api/traffic/tail?brand=brand-a");
    const brandCard = document.querySelector('[data-breakdown="brand"]') as HTMLElement;
    expect(within(brandCard).getByText("a.example")).toBeTruthy();
    expect(within(brandCard).queryByText("b.example")).toBeNull();
    const recent = screen.getByRole("region", { name: "ทราฟฟิกล่าสุด" });
    expect(within(recent).getByText("visible_row")).toBeTruthy();
    expect(within(recent).queryByText("hidden_row")).toBeNull();
  });

  it("asks for nothing and opens no stream when the scope shows no brand", async () => {
    visible = [];
    render(<RealtimeTab />);
    expect(await screen.findByText("ขอบเขตแบรนด์ไม่มีแบรนด์ที่แสดง")).toBeTruthy();
    await waitFor(() => expect(requests.filter((r) => r.startsWith("/api/traffic/"))).toEqual([]));
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
