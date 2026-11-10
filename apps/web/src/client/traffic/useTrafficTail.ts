import { TrafficTailEvent } from "@anjuna/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

/** Wait this long before opening the stream again after an error or a silent stream. */
export const RECONNECT_MS = 3_000;
/**
 * Liveness probe, as in the port source (realtime-client.js): a stream that sent neither an event nor a ping for this long is checked.
 * One that is still OPEN stays live and the probe arms again, because Cloudflare may deliver keepalives unevenly.
 * One that is CONNECTING or CLOSED is closed and opened again.
 */
export const SILENCE_MS = 150_000;
/** The report refresh waits for this long after the last event, so a burst of events asks once. */
export const REFRESH_DEBOUNCE_MS = 500;
/** Under steady traffic the quiet gap never comes, so a refresh is forced after this long. */
export const REFRESH_MAX_WAIT_MS = 10_000;
/** Newest events kept in memory. The stream shows 40 sessions, which fit well inside this. */
export const MAX_EVENTS = 400;
/** Event ids remembered for the duplicate check. A reconnect replays recent events, so this must outlast one replay. */
const SEEN_LIMIT = 2_000;
const RATE_WINDOW_MS = 60_000;
/** EventSource.OPEN. */
const OPEN = 1;

/** `idle`: no stream is open because no brand is in scope. */
export type TailStatus = "idle" | "connecting" | "live" | "reconnecting";

export interface TrafficTail {
  status: TailStatus;
  /** Newest first. Events with a repeated event_id are dropped. */
  events: TrafficTailEvent[];
  /** Wall clock of the last event received, or null when none arrived yet. */
  lastEventAt: number | null;
  /** Events that arrived in the last 60 seconds. */
  perMinute: number;
}

const EMPTY: TrafficTail = { status: "connecting", events: [], lastEventAt: null, perMinute: 0 };
const IDLE: TrafficTail = { ...EMPTY, status: "idle" };

export function tailUrl(brandIds: readonly string[]): string {
  return brandIds.length > 0 ? `/api/traffic/tail?${new URLSearchParams({ brand: brandIds.join(",") })}` : "/api/traffic/tail";
}

/**
 * The live event stream of the Traffic page: one EventSource on `/api/traffic/tail`.
 * - An error closes the stream and opens a new one after RECONNECT_MS. The new stream replays recent events, which the duplicate check drops.
 * - A stream that is silent for SILENCE_MS gets a liveness probe: still OPEN means it stays live and the probe arms again, anything else opens a new stream.
 * - The state belongs to one list of brands. A new list shows nothing of the old one, and a disabled hook reports `idle` with no events.
 * - Every event goes through the TrafficTailEvent schema; a frame that does not parse is skipped.
 * - `onRefresh` is called REFRESH_DEBOUNCE_MS after a connect or after the last event of a burst, and at least every REFRESH_MAX_WAIT_MS while events keep coming.
 * - `onAdsbot` is called once for each new AdsBot event.
 * `brandIds` limits the stream to those brands; an empty list means every brand. A change of the list opens a new stream.
 */
export function useTrafficTail(options: { brandIds: readonly string[]; enabled?: boolean; onRefresh?: () => void; onAdsbot?: (event: TrafficTailEvent) => void }): TrafficTail {
  const { brandIds, enabled = true } = options;
  const [held, setHeld] = useState<{ key: string; enabled: boolean; tail: TrafficTail }>({ key: "", enabled, tail: EMPTY });
  const refreshRef = useRef(options.onRefresh);
  const adsbotRef = useRef(options.onAdsbot);
  refreshRef.current = options.onRefresh;
  adsbotRef.current = options.onAdsbot;
  const arrivals = useRef<number[]>([]);
  const key = brandIds.join(",");
  const keyRef = useRef(key);
  keyRef.current = key;
  /** Writes to the held state only while it belongs to the list of brands on screen. */
  const setState = useCallback((update: TrafficTail | ((cur: TrafficTail) => TrafficTail)) => {
    setHeld((cur) => (cur.key === keyRef.current ? { ...cur, tail: typeof update === "function" ? update(cur.tail) : update } : cur));
  }, []);

  const rate = useCallback((now: number) => {
    arrivals.current = arrivals.current.filter((at) => now - at < RATE_WINDOW_MS);
    return arrivals.current.length;
  }, []);

  useEffect(() => {
    arrivals.current = [];
    if (!enabled || typeof EventSource === "undefined") {
      // No stream: nothing of an earlier one stays on screen, and the status does not claim a connection.
      setHeld({ key, enabled, tail: IDLE });
      return;
    }
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let burstStart: number | null = null;
    const seen = new Set<string>();
    setHeld({ key, enabled, tail: EMPTY });

    const runRefresh = () => {
      refreshTimer = undefined;
      burstStart = null;
      refreshRef.current?.();
    };
    /** Debounced: each call moves the refresh REFRESH_DEBOUNCE_MS out, but never later than REFRESH_MAX_WAIT_MS after the first call of the burst. */
    const askRefresh = () => {
      const now = Date.now();
      if (burstStart === null) burstStart = now;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(runRefresh, Math.max(0, Math.min(REFRESH_DEBOUNCE_MS, burstStart + REFRESH_MAX_WAIT_MS - now)));
    };

    const armSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        // Liveness probe: a quiet stream that is still OPEN is healthy, so it stays live and the probe arms again.
        if (!closed && source?.readyState === OPEN) { armSilence(); return; }
        reconnect();
      }, SILENCE_MS);
    };

    function reconnect() {
      if (closed) return;
      source?.close();
      source = null;
      if (silenceTimer) clearTimeout(silenceTimer);
      setState((cur) => ({ ...cur, status: "reconnecting" }));
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    }

    function connect() {
      if (closed) return;
      const next = new EventSource(tailUrl(brandIds));
      source = next;
      next.onopen = () => {
        if (closed || source !== next) return;
        setState((cur) => ({ ...cur, status: "live" }));
        armSilence();
        askRefresh();
      };
      next.onerror = () => {
        if (closed || source !== next) return;
        reconnect();
      };
      next.addEventListener("ping", () => { if (!closed && source === next) armSilence(); });
      next.addEventListener("event", (message) => {
        if (closed || source !== next) return;
        let parsed: ReturnType<typeof TrafficTailEvent.safeParse>;
        try {
          parsed = TrafficTailEvent.safeParse(JSON.parse((message as MessageEvent<string>).data));
        } catch {
          return;
        }
        armSilence();
        if (!parsed.success) return;
        const event = parsed.data;
        if (seen.has(event.event_id)) return;
        seen.add(event.event_id);
        if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
        const now = Date.now();
        arrivals.current.push(now);
        setState((cur) => ({
          ...cur, status: "live", lastEventAt: now, perMinute: rate(now),
          events: [event, ...cur.events].slice(0, MAX_EVENTS),
        }));
        if (event.user_agent_family === "adsbot") adsbotRef.current?.(event);
        askRefresh();
      });
    }

    connect();
    // The count of the last minute falls without any new event, so it is read again every few seconds.
    const ticker = setInterval(() => setState((cur) => (cur.perMinute === rate(Date.now()) ? cur : { ...cur, perMinute: rate(Date.now()) })), 5_000);
    return () => {
      closed = true;
      source?.close();
      clearTimeout(reconnectTimer);
      clearTimeout(silenceTimer);
      clearTimeout(refreshTimer);
      clearInterval(ticker);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  // State written for another list of brands, or before this one was set up, is never shown.
  return held.key === key && held.enabled === enabled ? held.tail : enabled ? EMPTY : IDLE;
}
