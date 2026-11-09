import { afterAll, beforeAll, expect, it } from "vitest";
import { TrafficTailEvent } from "@anjuna/contracts";
import { createHarness, hash, type Harness } from "./helpers.js";
import { classifyUserAgent } from "../src/traffic-tail/index.js";

let h: Harness;
beforeAll(async () => { h = await createHarness({ trafficTail: true, brand: true }); await h.seedAccount(); await h.seedBrand(); });
afterAll(async () => { await h?.mf.dispose(); });
const post = (ua: string, session: string) => h.request("/analytics/telemetry", { method: "POST",
  headers: { authorization: "Bearer account-a-token", "content-type": "application/json", "user-agent": ua },
  body: JSON.stringify({ brand_id: "brand-a", hostname: "brand-a.example", kind: "telemetry", path: "/",
    content_type: "application/json", body: JSON.stringify({ event_type: "landing_viewed", session_id: session }) }) });

async function until(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, timeout = 2000): Promise<string> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      (async () => { let text = ""; while (!text.includes(needle)) { const chunk = await reader.read(); if (chunk.done) throw new Error("closed"); text += new TextDecoder().decode(chunk.value); } return text; })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("stream timeout")), timeout); }),
    ]);
  } finally { clearTimeout(timer!); }
}

it("telemetry reaches SSE within 2 seconds; hashed session, brand filter, dedupe and ping", async () => {
  const namespace = await h.mf.getDurableObjectNamespace("TRAFFIC_TAIL", "production");
  const stub = namespace.get(namespace.idFromName("tail"));
  const response = await stub.fetch("https://tail.internal/sse?brand=brand-a");
  const reader = response.body!.getReader();
  try {
    expect(await until(reader, "connected")).toContain("retry: 3000");
    const start = Date.now();
    expect((await post("AdsBot-Google-Mobile", "private-session")).status).toBe(204);
    const text = await until(reader, "event: event");
    expect(Date.now() - start).toBeLessThan(2000);
    const event = TrafficTailEvent.parse(JSON.parse(text.split("data: ")[1]!.split("\n")[0]!));
    expect(event.session_ref).toBe(hash("private-session").slice(0, 16));
    expect(event.user_agent_family).toBe("adsbot");
    expect(text).not.toContain("private-session");
    expect(await (await stub.fetch("https://tail.internal/push", { method: "POST", body: JSON.stringify(event) })).json()).toEqual({ status: "duplicate" });
    await stub.fetch("https://tail.internal/push", { method: "POST", body: JSON.stringify({ ...event, event_id: "other-brand", brand: "brand-b" }) });
    const ping = await until(reader, "event: ping", 20_000);
    expect(ping).not.toContain("event: event");
  } finally { await reader.cancel(); }
});

it("browser and AdsBot telemetry response bytes are identical", async () => {
  const browser = await post("Mozilla/5.0 Chrome", "browser-session");
  const bot = await post("AdsBot-Google", "bot-session");
  expect(browser.status).toBe(bot.status);
  expect(await browser.text()).toBe(await bot.text());
  expect(browser.headers.get("content-type")).toBe(bot.headers.get("content-type"));
  expect(browser.headers.get("cache-control")).toBe(bot.headers.get("cache-control"));
  const rows = await h.db.prepare("SELECT user_agent_family FROM traffic_events WHERE session_id IN ('browser-session','bot-session') ORDER BY session_id").all<{ user_agent_family: string }>();
  expect(rows.results.map(r => r.user_agent_family)).toEqual(["adsbot", "browser"]);
});

it("classifies only for observation", () => {
  expect(["AdsBot-Google", "AdsBot-Google-Mobile", "Googlebot", "bingbot", "Mozilla/5.0", ""].map(classifyUserAgent))
    .toEqual(["adsbot", "adsbot", "googlebot", "other-bot", "browser", "unknown"]);
});

it("forwards validated visitor geography from brand through the core transport into D1", async () => {
  const brand = await h.mf.getWorker("brand");
  const cases = [
    { session: "geo-valid", cf: { country: "US", region: "Texas" }, expected: { country: "US", region: "Texas" } },
    // Miniflare supplies default geography for omitted cf keys; null models unavailable edge values.
    { session: "geo-missing", cf: { country: null, region: null }, expected: { country: null, region: null } },
    { session: "geo-invalid", cf: { country: "invalid", region: "x".repeat(129) }, expected: { country: null, region: null } },
  ];
  let previous: unknown;
  for (const { session, cf, expected } of cases) {
    const response = await brand.fetch("https://brand-a.example/api/telemetry", {
      method: "POST", cf, headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
      body: JSON.stringify({ event_type: "landing_viewed", session_id: session, country: "ZZ", region: "forged", visitor: { country: "ZZ" } }),
    });
    const snapshot = [response.status, Object.fromEntries(response.headers), await response.text()];
    expect(response.status).toBe(204);
    if (previous) expect(snapshot).toEqual(previous);
    previous = snapshot;
    expect(await h.db.prepare("SELECT country,region FROM traffic_events WHERE session_id=?1").bind(session).first()).toEqual(expected);
  }
});

it("ring replays at most 500 events and rejects private fields", async () => {
  const namespace = await h.mf.getDurableObjectNamespace("TRAFFIC_TAIL", "production");
  const stub = namespace.get(namespace.idFromName("ring-test"));
  const base = { ts: Date.now(), event_type: "landing_viewed", session_ref: null, brand: "brand-a", domain: "brand-a.example",
    device_type: null, browser: null, user_agent_family: "browser", url: "https://brand-a.example/", http_status: null, response_ms: null, gate_passed: null };
  for (let i = 0; i < 501; i++) await stub.fetch("https://tail.internal/push", { method: "POST", body: JSON.stringify({ ...base, event_id: `ring-${i}` }) });
  expect((await stub.fetch("https://tail.internal/push", { method: "POST", body: JSON.stringify({ ...base, event_id: "bad", email: "private" }) })).status).toBe(400);
  const stream = await stub.fetch("https://tail.internal/sse");
  const reader = stream.body!.getReader();
  try {
    const text = await until(reader, "id: ring-500", 5000);
    expect(text.match(/event: event/g)).toHaveLength(500);
    expect(text).not.toContain("id: ring-0\n");
  } finally { await reader.cancel(); }
});
