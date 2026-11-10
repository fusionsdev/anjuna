import type { TrafficTailEvent } from "@anjuna/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_EVENTS, REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS, RECONNECT_MS, SILENCE_MS, tailUrl, useTrafficTail } from "../src/client/traffic/useTrafficTail";
import { MockEventSource, tailEvent } from "./traffic-helpers";

beforeEach(() => {
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const mount = (options: Partial<Parameters<typeof useTrafficTail>[0]> = {}) => renderHook((props: Parameters<typeof useTrafficTail>[0]) => useTrafficTail(props), { initialProps: { brandIds: [], ...options } });

describe("tailUrl", () => {
  it("asks for every brand without a brand parameter and for a list with one", () => {
    expect(tailUrl([])).toBe("/api/traffic/tail");
    expect(tailUrl(["brand-a", "brand-b"])).toBe("/api/traffic/tail?brand=brand-a%2Cbrand-b");
  });
});

describe("useTrafficTail", () => {
  it("opens one stream, goes live on open and keeps events newest first", () => {
    const { result } = mount();
    expect(result.current.status).toBe("connecting");
    expect(MockEventSource.instances).toHaveLength(1);
    act(() => MockEventSource.last().open());
    expect(result.current.status).toBe("live");
    act(() => MockEventSource.last().emit("event", tailEvent({ event_id: "e1", ts: 1_800_000_000_000 })));
    act(() => MockEventSource.last().emit("event", tailEvent({ event_id: "e2", ts: 1_800_000_001_000 })));
    expect(result.current.events.map((e) => e.event_id)).toEqual(["e2", "e1"]);
    expect(result.current.lastEventAt).toBe(Date.now());
  });

  it("drops an event whose event_id was already seen, such as a replay after a reconnect", () => {
    const { result } = mount();
    act(() => MockEventSource.last().open());
    const event = tailEvent({ event_id: "same" });
    act(() => { MockEventSource.last().emit("event", event); MockEventSource.last().emit("event", event); });
    expect(result.current.events).toHaveLength(1);
    // The replay on a new stream repeats the event; it is still dropped.
    act(() => MockEventSource.last().error());
    tick(RECONNECT_MS);
    act(() => { MockEventSource.last().open(); MockEventSource.last().emit("event", event); MockEventSource.last().emit("event", tailEvent({ event_id: "fresh" })); });
    expect(result.current.events.map((e) => e.event_id)).toEqual(["fresh", "same"]);
  });

  it("skips a frame that is not JSON or does not match the event schema", () => {
    const { result } = mount();
    act(() => MockEventSource.last().open());
    act(() => {
      MockEventSource.last().emitRaw("event", "{not json");
      MockEventSource.last().emit("event", { ...tailEvent(), event_type: "page_exploded" });
      MockEventSource.last().emit("event", { ...tailEvent(), extra: "field" });
    });
    expect(result.current.events).toHaveLength(0);
  });

  it("keeps at most MAX_EVENTS events", () => {
    const { result } = mount();
    act(() => MockEventSource.last().open());
    act(() => { for (let i = 0; i < MAX_EVENTS + 25; i++) MockEventSource.last().emit("event", tailEvent({ event_id: `e${i}` })); });
    expect(result.current.events).toHaveLength(MAX_EVENTS);
    expect(result.current.events[0]!.event_id).toBe(`e${MAX_EVENTS + 24}`);
  });

  it("closes the stream on an error and opens a new one after 3 seconds", () => {
    const { result } = mount();
    act(() => MockEventSource.last().open());
    const first = MockEventSource.last();
    act(() => first.error());
    expect(first.closed).toBe(true);
    expect(result.current.status).toBe("reconnecting");
    tick(RECONNECT_MS - 1);
    expect(MockEventSource.instances).toHaveLength(1);
    tick(1);
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => MockEventSource.last().open());
    expect(result.current.status).toBe("live");
  });

  it("opens a new stream when nothing, not even a ping, arrives for 150 seconds", () => {
    const { result } = mount();
    act(() => MockEventSource.last().open());
    tick(SILENCE_MS - 1000);
    act(() => MockEventSource.last().emit("ping", { ts: Date.now() }));
    tick(SILENCE_MS - 1000);
    // The ping moved the deadline, so the stream is still the first one.
    expect(MockEventSource.instances).toHaveLength(1);
    tick(1000);
    expect(result.current.status).toBe("reconnecting");
    expect(MockEventSource.instances[0]!.closed).toBe(true);
    tick(RECONNECT_MS);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("asks for a refresh once, 500 ms after the connect", () => {
    const onRefresh = vi.fn();
    mount({ onRefresh });
    act(() => MockEventSource.last().open());
    tick(REFRESH_DEBOUNCE_MS - 1);
    expect(onRefresh).not.toHaveBeenCalled();
    tick(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("asks once for a burst of events, 500 ms after the last one", () => {
    const onRefresh = vi.fn();
    mount({ onRefresh });
    act(() => MockEventSource.last().open());
    tick(REFRESH_DEBOUNCE_MS);
    onRefresh.mockClear();
    for (const id of ["a", "b", "c"]) {
      act(() => MockEventSource.last().emit("event", tailEvent({ event_id: id })));
      tick(200);
    }
    expect(onRefresh).not.toHaveBeenCalled();
    tick(REFRESH_DEBOUNCE_MS - 200);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("forces a refresh every 10 seconds while events keep coming", () => {
    const onRefresh = vi.fn();
    mount({ onRefresh });
    act(() => MockEventSource.last().open());
    tick(REFRESH_DEBOUNCE_MS);
    onRefresh.mockClear();
    // One event every 300 ms never leaves a 500 ms gap.
    for (let i = 0; i < Math.ceil(REFRESH_MAX_WAIT_MS / 300) + 2; i++) {
      act(() => MockEventSource.last().emit("event", tailEvent({ event_id: `s${i}` })));
      tick(300);
    }
    expect(onRefresh.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("calls onAdsbot for each new AdsBot event and not for a browser or a duplicate", () => {
    const onAdsbot = vi.fn();
    mount({ onAdsbot });
    act(() => MockEventSource.last().open());
    const bot = tailEvent({ event_id: "bot1", user_agent_family: "adsbot" });
    act(() => {
      MockEventSource.last().emit("event", tailEvent({ event_id: "human" }));
      MockEventSource.last().emit("event", bot);
      MockEventSource.last().emit("event", bot);
    });
    expect(onAdsbot).toHaveBeenCalledTimes(1);
    expect((onAdsbot.mock.calls[0]![0] as TrafficTailEvent).event_id).toBe("bot1");
  });

  it("counts the events of the last minute", () => {
    const { result } = mount();
    act(() => MockEventSource.last().open());
    act(() => { for (const id of ["a", "b", "c"]) MockEventSource.last().emit("event", tailEvent({ event_id: id })); });
    expect(result.current.perMinute).toBe(3);
    tick(65_000);
    // The silence timer reopens the stream at 150 s, so 65 s is inside one stream.
    expect(result.current.perMinute).toBe(0);
  });

  it("opens a new stream for a new brand list and closes the old one", () => {
    const { rerender } = mount({ brandIds: ["brand-a"] });
    expect(MockEventSource.last().url).toBe("/api/traffic/tail?brand=brand-a");
    const first = MockEventSource.last();
    rerender({ brandIds: ["brand-b"] });
    expect(first.closed).toBe(true);
    expect(MockEventSource.last().url).toBe("/api/traffic/tail?brand=brand-b");
  });

  it("opens nothing while disabled and closes the stream on unmount", () => {
    const off = mount({ enabled: false });
    expect(MockEventSource.instances).toHaveLength(0);
    off.unmount();
    const on = mount();
    const stream = MockEventSource.last();
    on.unmount();
    expect(stream.closed).toBe(true);
    // No reconnect is scheduled after the unmount.
    tick(RECONNECT_MS * 2);
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
