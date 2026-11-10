import type { TrafficRealtimeResponse, TrafficTailEvent } from "@anjuna/contracts";

/** An EventSource the test drives by hand: open, emit named events, error. It records every instance the page made. */
export class MockEventSource {
  static instances: MockEventSource[] = [];
  static reset() { MockEventSource.instances = []; }
  static last(): MockEventSource {
    const found = MockEventSource.instances[MockEventSource.instances.length - 1];
    if (!found) throw new Error("no EventSource was opened");
    return found;
  }

  readonly url: string;
  closed = false;
  /** 0 connecting, 1 open, 2 closed, as EventSource.readyState. A test may set it to stage a stream the browser reports as dead. */
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener() { /* not used */ }
  close() { this.closed = true; this.readyState = 2; }

  open() { this.readyState = 1; this.onopen?.(new Event("open")); }
  error() { this.onerror?.(new Event("error")); }
  emit(type: string, data: unknown) { this.emitRaw(type, JSON.stringify(data)); }
  emitRaw(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
  }
}

let counter = 0;
/** A valid stream event. Override what the test cares about. */
export function tailEvent(over: Partial<TrafficTailEvent> = {}): TrafficTailEvent {
  counter += 1;
  return {
    event_id: `evt${counter}`, ts: 1_800_000_000_000 + counter, event_type: "landing_viewed", session_ref: "aaaaaaaaaaaaaaaa",
    brand: "brand-a", domain: "brand-a.example", device_type: "mobile", browser: "chrome", user_agent_family: "browser",
    url: "https://brand-a.example/", http_status: 200, response_ms: 120, gate_passed: true, ...over,
  };
}

/** A valid realtime report. Override the parts the test reads. */
export function realtimeReport(over: Partial<TrafficRealtimeResponse> = {}): TrafficRealtimeResponse {
  return {
    period: "24h", from: "2026-11-09T10:00:00.000Z", to: "2026-11-10T10:00:00.000Z",
    kpis: {
      landing_views: 1234, form_starts: 456, leads: 78, validation_errors: 9, redirect_errors: 2, suspicious_sessions: 5,
      no_gclid_landings: { count: 40, pct: 3.2 }, gate_drops: 11, non_us_pct: 6.5,
    },
    deltas: { landing_views: 12, form_starts: -8, leads: 0, validation_errors: 25, redirect_errors: null, suspicious_sessions: null, no_gclid_landings: -5, gate_drops: 3, non_us_pct: null },
    bots_now: { googlebot: { current_hour: 14, "24h": 300 }, adsbot: { current_hour: 2, "24h": 31 }, "other-bot": { current_hour: 0, "24h": 7 } },
    adsbot_last: [],
    breakdowns: {
      source: [{ key: "google", count: 900, pct: 72.9 }, { key: "direct", count: 334, pct: 27.1 }],
      hostname: [{ key: "brand-a.example", count: 1000, pct: 81 }],
      device: [{ key: "mobile", count: 800, pct: 65 }], browser: [{ key: "chrome", count: 700, pct: 56.7 }],
      brand: [{ key: "brand-a", count: 1000, pct: 81 }, { key: "brand-b", count: 234, pct: 19 }],
    },
    trend: [
      { at: "2026-11-10T08:00:00.000Z", landing_views: 100, form_starts: 40, leads: 5 },
      { at: "2026-11-10T09:00:00.000Z", landing_views: 200, form_starts: 80, leads: 10 },
    ],
    recent: [{
      at: "2026-11-10T09:59:30.000Z", event_type: "lead_submitted", hostname: "brand-a.example", brand: "brand-a", source: "google", campaign: "search-1",
      device: "mobile", browser: "chrome", form_step: 3, error_code: null, session_ref: "aaaaaaaaaaaaaaaa", user_agent_family: "browser",
    }],
    ...over,
  };
}
