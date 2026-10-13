import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { initPostHog, posthogConfig, POSTHOG_PLACEHOLDER_KEY, trackEvent } from "../src/lib/analytics";

// FO-3 / BR-11: PostHog is bundled into the form and talks only to the brand's proxy path.
// The brand Worker accepts POST of plain JSON on the proxy path and nothing else.

// posthog-js captures window.fetch / XMLHttpRequest when its module loads, so the transport
// stubs must exist before the import above is evaluated.
const net = vi.hoisted(() => {
  const calls: { via: string; method: string; url: string; body: string }[] = [];
  // What the stubbed brand proxy answers. Tests change it; beforeEach resets it to the SDK-friendly default.
  const reply = { status: 200, body: "{}", contentType: "application/json" };
  class FakeXhr {
    method = "";
    url = "";
    withCredentials = false;
    status = 200;
    responseText = "{}";
    readyState = 4;
    onreadystatechange: (() => void) | null = null;
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader() {}
    send(body?: unknown) {
      calls.push({ via: "xhr", method: this.method, url: this.url, body: String(body ?? "") });
    }
  }
  const fakeFetch = async (url: unknown, init?: { method?: string; body?: unknown }) => {
    calls.push({ via: "fetch", method: init?.method ?? "GET", url: String(url), body: String(init?.body ?? "") });
    const { status, body, contentType } = reply;
    return {
      status, ok: status >= 200 && status < 300, text: async () => body,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    };
  };
  const w = globalThis as unknown as Record<string, unknown>;
  w.XMLHttpRequest = FakeXhr;
  w.fetch = fakeFetch;
  Object.defineProperty(globalThis.navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, body?: unknown) => {
      calls.push({ via: "beacon", method: "POST", url, body: String(body ?? "") });
      return true;
    },
  });
  return { calls, reply };
});

describe("posthogConfig", () => {
  it("points every request at the proxy path and turns off all remote code, config and GET paths", () => {
    expect(posthogConfig("/_ph")).toMatchObject({
      api_host: "/_ph",
      disable_compression: true,
      disable_beacon: true,
      request_batching: false,
      advanced_disable_flags: true,
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
      disable_external_dependency_loading: true,
      disable_session_recording: true,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      capture_performance: false,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      person_profiles: "identified_only",
    });
  });
});

describe("initPostHog (real SDK, stubbed transport)", () => {
  const scripts: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    net.calls.length = 0;
    Object.assign(net.reply, { status: 200, body: "{}", contentType: "application/json" });
    scripts.length = 0;
    // jsdom's user agent is on posthog-js's bot list; use a browser one so capture is not dropped.
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    );
    const append = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation(((node: Node) => {
      if (node instanceof HTMLScriptElement) scripts.push(node.src);
      return append(node);
    }) as typeof document.head.appendChild);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does nothing without a proxy path", () => {
    initPostHog(undefined);
    trackEvent("landing_viewed");
    vi.advanceTimersByTime(10_000);
    expect(net.calls).toEqual([]);
  });

  it("sends only POST requests to the proxy path with the placeholder key, and loads no script", async () => {
    initPostHog("/_ph");
    trackEvent("landing_viewed", { route: "/" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(net.calls.length).toBeGreaterThan(0);
    for (const c of net.calls) {
      expect(c.method).toBe("POST");
      const u = new URL(c.url, "https://brand.test");
      expect(u.origin).toBe("https://brand.test");
      expect(u.pathname).toMatch(/^\/_ph\/(e|i\/v0\/e|batch|capture)\/?$/);
    }
    expect(scripts).toEqual([]);
    const body = net.calls.map((c) => c.body).join("\n");
    expect(body).toContain(POSTHOG_PLACEHOLDER_KEY);
    expect(body).toContain("landing_viewed");
  });

  it("flushes on page hide as a JSON POST, never through sendBeacon", async () => {
    initPostHog("/_ph");
    trackEvent("landing_viewed", { route: "/" });
    window.dispatchEvent(new Event("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(net.calls.length).toBeGreaterThan(0);
    for (const c of net.calls) {
      expect(c.via).not.toBe("beacon");
      expect(c.method).toBe("POST");
      expect(c.url).not.toContain("compression");
      expect(() => JSON.parse(c.body)).not.toThrow();
    }
  });

  // FUS-339: posthog-js retries every response that is not 200 and not 4xx (retry-queue.js,
  // `statusCode !== 200 && (statusCode < 400 || statusCode >= 500)`), so a 204 is a failure to the SDK.
  // Each test loads a fresh SDK: the singleton keeps its retry queue and pagehide listeners between tests.
  describe("response handling", () => {
    // What the brand Worker answers a proxied PostHog POST (packages/brand-runtime/src/worker.ts).
    // Pinned to the same literal by packages/brand-runtime/test/analytics.test.ts.
    const BRAND_POSTHOG_ANSWER = { status: 200, body: '{"status":1}', contentType: "application/json" };

    const sendOneEvent = async () => {
      // No jitter: the first retry is due at 3 s and goes out on the 6 s poll, the second is due at 18 s.
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      vi.resetModules();
      const fresh = await import("../src/lib/analytics");
      fresh.initPostHog("/_ph");
      fresh.trackEvent("landing_viewed", { route: "/" });
      await vi.advanceTimersByTimeAsync(10_000);
      return net.calls.map((c) => c.url);
    };

    it("retries an empty 204 with ?retry_count=1, so one event is sent twice", async () => {
      Object.assign(net.reply, { status: 204, body: "", contentType: "" });
      expect(await sendOneEvent()).toEqual(["/_ph/e/", "/_ph/e/?retry_count=1"]);
    });

    it("does not retry the brand's PostHog answer: one event, one request", async () => {
      Object.assign(net.reply, BRAND_POSTHOG_ANSWER);
      expect(await sendOneEvent()).toEqual(["/_ph/e/"]);
    });

    it("does not retry a 200 with an empty body either, so the retry rule is the status and not the body", async () => {
      Object.assign(net.reply, { status: 200, body: "", contentType: "" });
      expect(await sendOneEvent()).toEqual(["/_ph/e/"]);
    });

    it("still retries a 503 from the brand Worker (core failure)", async () => {
      Object.assign(net.reply, { status: 503, body: '{"error":"unavailable"}', contentType: "application/json" });
      expect(await sendOneEvent()).toEqual(["/_ph/e/", "/_ph/e/?retry_count=1"]);
    });
  });
});
