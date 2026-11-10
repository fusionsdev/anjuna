import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeTab } from "../src/client/traffic/RealtimeTab";
import { MockEventSource, realtimeReport, tailEvent } from "./traffic-helpers";

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

describe("Realtime tab when the scope changes while the page is open", () => {
  const emit = (over: Parameters<typeof tailEvent>[0]) => act(() => MockEventSource.last().emit("event", tailEvent(over)));
  const rows = () => [...document.querySelectorAll<HTMLElement>(".rt-session")];
  const openPage = async () => {
    visible = ["brand-a", "brand-b"];
    const view = render(<RealtimeTab />);
    await screen.findByRole("region", { name: "ตัวเลขสำคัญ" });
    act(() => MockEventSource.last().open());
    return view;
  };

  it("drops the AdsBot banner and the feed of a brand the new scope hides, even while the feed is paused", async () => {
    const view = await openPage();
    const first = MockEventSource.last();
    expect(first.url).toBe("/api/traffic/tail?brand=brand-a%2Cbrand-b");
    emit({ event_id: "a1", brand: "brand-a", domain: "a.example", session_ref: "aaaaaaaaaaaaaaaa" });
    emit({ event_id: "b1", brand: "brand-b", domain: "b.example", session_ref: "bbbbbbbbbbbbbbbb" });
    emit({ event_id: "b2", brand: "brand-b", domain: "b.example", session_ref: "b2b2b2b2b2b2b2b2", user_agent_family: "adsbot", http_status: 200 });
    expect(screen.getByRole("alert").textContent).toContain("b.example");
    // Pause the feed: it now holds a frozen copy with brand-b rows.
    fireEvent.click(screen.getByRole("button", { name: /หยุดชั่วคราว/ }));
    expect(rows().map((r) => r.querySelector("b")!.textContent)).toContain("b.example");

    visible = ["brand-a"];
    view.rerender(<RealtimeTab />);

    // The banner for brand-b is gone, and so is every brand-b row of the frozen feed. The pause is released.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/b\.example/)).toBeNull();
    expect(rows()).toHaveLength(0);
    expect(screen.getByRole("button", { name: /หยุดชั่วคราว/ }).getAttribute("aria-pressed")).toBe("false");
    expect(first.closed).toBe(true);
    expect(MockEventSource.last().url).toBe("/api/traffic/tail?brand=brand-a");
    // A late frame of the old stream is ignored; the new stream shows only what it sends.
    act(() => first.emit("event", tailEvent({ event_id: "b3", brand: "brand-b", domain: "b.example", session_ref: "b3b3b3b3b3b3b3b3" })));
    expect(rows()).toHaveLength(0);
    act(() => MockEventSource.last().open());
    emit({ event_id: "a2", brand: "brand-a", domain: "a.example", session_ref: "a2a2a2a2a2a2a2a2" });
    expect(rows()).toHaveLength(1);
  });

  it("drops a live AdsBot visit when the scope changes, and shows no banner for the hidden brand even if it is the newest", async () => {
    const view = await openPage();
    emit({ event_id: "b4", brand: "brand-b", domain: "b.example", session_ref: "b4b4b4b4b4b4b4b4", user_agent_family: "adsbot", http_status: 503 });
    expect(screen.getByRole("alert").getAttribute("data-tone")).toBe("danger");
    visible = ["brand-a"];
    view.rerender(<RealtimeTab />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes the stream, clears the feed and reports idle when the scope shows no brand", async () => {
    const view = await openPage();
    const stream = MockEventSource.last();
    emit({ event_id: "a3", brand: "brand-a", domain: "a.example", session_ref: "a3a3a3a3a3a3a3a3" });
    emit({ event_id: "b5", brand: "brand-b", domain: "b.example", session_ref: "b5b5b5b5b5b5b5b5", user_agent_family: "adsbot" });
    expect(rows()).toHaveLength(2);
    visible = [];
    view.rerender(<RealtimeTab />);
    expect(stream.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(screen.getByText("ไม่ได้เชื่อมต่อ ไม่มีแบรนด์ในขอบเขต")).toBeTruthy();
    expect(screen.queryByText("เชื่อมต่อแล้ว")).toBeNull();
    expect(screen.queryByRole("region", { name: "ทราฟฟิกสด" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rows()).toHaveLength(0);
  });
});
