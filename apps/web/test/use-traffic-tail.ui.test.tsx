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

  it("opens a new stream when nothing, not even a ping, arrives for 150 seconds and the browser reports it dead", () => {
    const { result } = mount();
    act(() => MockEventSource.last().open());
    tick(SILENCE_MS - 1000);
    act(() => MockEventSource.last().emit("ping", { ts: Date.now() }));
    tick(SILENCE_MS - 1000);
    // The ping moved the deadline, so the stream is still the first one.
    expect(MockEventSource.instances).toHaveLength(1);
    // The probe finds the stream no longer OPEN (the browser gave up on it), so it is opened again.
    MockEventSource.instances[0]!.readyState = 2;
    tick(1000);
    expect(result.current.status).toBe("reconnecting");
    expect(MockEventSource.instances[0]!.closed).toBe(true);
    tick(RECONNECT_MS);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("keeps a silent stream that is still OPEN live and probes it again 150 seconds later", () => {
    const { result } = mount();
    act(() => MockEventSource.last().open());
    expect(MockEventSource.last().readyState).toBe(1);
    // Nothing arrives for three probe periods. Each probe sees readyState OPEN, so no reconnect, no status change, no second stream.
    for (let n = 0; n < 3; n += 1) {
      tick(SILENCE_MS);
      expect(result.current.status).toBe("live");
      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0]!.closed).toBe(false);
    }
    // An event still arrives on that same stream.
    act(() => MockEventSource.last().emit("event", tailEvent({ event_id: "late" })));
    expect(result.current.events.map((e) => e.event_id)).toEqual(["late"]);
    // When a probe finds the stream CONNECTING or CLOSED, the usual reconnect runs.
    MockEventSource.last().readyState = 0;
    tick(SILENCE_MS);
    expect(result.current.status).toBe("reconnecting");
    expect(MockEventSource.instances[0]!.closed).toBe(true);
    tick(RECONNECT_MS);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("shows nothing of the old brands after the list changes, opens a stream for the new list and ignores the old stream", () => {
    const { result, rerender } = mount({ brandIds: ["brand-a", "brand-b"] });
    act(() => MockEventSource.last().open());
    const old = MockEventSource.last();
    act(() => old.emit("event", tailEvent({ event_id: "a1", brand: "brand-a" })));
    act(() => old.emit("event", tailEvent({ event_id: "b1", brand: "brand-b" })));
    expect(result.current.events).toHaveLength(2);
    rerender({ brandIds: ["brand-a"] });
    expect(result.current.events).toEqual([]);
    expect(result.current.lastEventAt).toBeNull();
    expect(result.current.status).toBe("connecting");
    expect(old.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.last().url).toBe("/api/traffic/tail?brand=brand-a");
    // A late frame from the closed stream changes nothing.
    act(() => old.emit("event", tailEvent({ event_id: "b2", brand: "brand-b" })));
    expect(result.current.events).toEqual([]);
    act(() => MockEventSource.last().open());
    act(() => MockEventSource.last().emit("event", tailEvent({ event_id: "a2", brand: "brand-a" })));
    expect(result.current.events.map((e) => e.event_id)).toEqual(["a2"]);
  });

  it("resets to idle with no events when it is disabled, and starts again when it is enabled", () => {
    const { result, rerender } = mount({ brandIds: ["brand-a"] });
    act(() => MockEventSource.last().open());
    act(() => MockEventSource.last().emit("event", tailEvent({ event_id: "a1", brand: "brand-a" })));
    expect(result.current.status).toBe("live");
    expect(result.current.events).toHaveLength(1);
    const first = MockEventSource.last();
    rerender({ brandIds: ["brand-a"], enabled: false });
    expect(first.closed).toBe(true);
    expect(result.current).toEqual({ status: "idle", events: [], lastEventAt: null, perMinute: 0 });
    tick(RECONNECT_MS + SILENCE_MS);
    expect(MockEventSource.instances).toHaveLength(1);
    rerender({ brandIds: ["brand-a"], enabled: true });
    expect(result.current.status).toBe("connecting");
    expect(result.current.events).toEqual([]);
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
