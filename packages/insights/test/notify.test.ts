import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { InMemorySubmitErrorCounts, MultiNotifier, TelegramNotifier, defaultNotifySettings, formatDigest, formatNotice, runAlerts, type Notice } from "../src/index.js";
import { insertLead, insertConversion } from "./seed.js";

const TOKEN = "test-telegram-DO-NOT-LOG";
const at = "2026-11-10T02:00:00.000Z";
const notice: Notice = { key: "submit_error_rate:brand-a", rule: "submit_error_rate", brand: "brand-a", level: "warn", metric: "12.5%" };
const message = formatNotice(notice, at, "panel.example");
const settings = () => ({ ...defaultNotifySettings(), telegram: { enabled: true, chat_ids: ["123"] } });
beforeAll(async () => { await applyD1Migrations(env.DB, env.MIGRATIONS); });
beforeEach(async () => { await env.DB.batch([env.DB.prepare("DELETE FROM alert_state"), env.DB.prepare("DELETE FROM notification_log")]); });
const logs = async () => (await env.DB.prepare("SELECT * FROM notification_log ORDER BY sent_at,id").all()).results;
const ok = new TelegramNotifier(TOKEN, (async () => Response.json({ ok: true })) as typeof fetch);

it("Telegram sends HTML, disables previews and includes one panel button", async () => {
  let payload: unknown;
  const telegram = new TelegramNotifier(TOKEN, (async (_url, init) => { payload = JSON.parse(String(init?.body)); return Response.json({ ok: true }); }) as typeof fetch);
  expect(await telegram.send("123", message)).toEqual({ status: "sent", response_code: 200 });
  expect(payload).toEqual({ chat_id: "123", text: message.text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "เปิดใน panel", url: "https://panel.example/alerts?key=submit_error_rate%3Abrand-a" }]] } });
});
it("429 honours retry_after and retries once successfully", async () => {
  let calls = 0; const waits: number[] = [];
  const telegram = new TelegramNotifier(TOKEN, (async () => ++calls === 1 ? Response.json({ parameters: { retry_after: 2 } }, { status: 429 }) : Response.json({ ok: true })) as typeof fetch,
    async ms => { waits.push(ms); });
  expect(await telegram.send("123", message)).toEqual({ status: "sent", response_code: 200 });
  expect(calls).toBe(2); expect(waits).toEqual([2000]);
});
it("5xx retries once, logs failure and never persists provider body or token", async () => {
  let calls = 0;
  const telegram = new TelegramNotifier(TOKEN, (async () => { calls++; return Response.json({ description: TOKEN }, { status: calls === 1 ? 500 : 503 }); }) as typeof fetch, async () => {});
  const notifier = new MultiNotifier(env.DB, settings(), telegram);
  await notifier.process(notice, at);
  expect(calls).toBe(2);
  expect(await logs()).toEqual([expect.objectContaining({ status: "failed", response_code: 503, body_hash: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  expect(JSON.stringify(await logs())).not.toContain(TOKEN);
  expect(JSON.stringify((await env.DB.prepare("SELECT * FROM alert_state").all()).results)).not.toContain(TOKEN);
});
it("ok to warn sends; unchanged warn waits; escalation sends; acknowledgement holds until recovery", async () => {
  const notifier = new MultiNotifier(env.DB, settings(), ok);
  await notifier.process({ ...notice, level: "ok" }, at);
  await notifier.process(notice, at);
  await notifier.process(notice, "2026-11-10T02:30:00.000Z");
  expect(await logs()).toHaveLength(1);
  await notifier.process({ ...notice, level: "alert" }, "2026-11-10T02:31:00.000Z");
  expect(await logs()).toHaveLength(2);
  await env.DB.prepare("UPDATE alert_state SET acknowledged_by='owner', acknowledged_at=?1 WHERE alert_key=?2").bind(at, notice.key).run();
  await notifier.process({ ...notice, level: "alert" }, "2026-11-11T02:00:00.000Z");
  expect(await logs()).toHaveLength(2);
  await notifier.process({ ...notice, level: "ok" }, "2026-11-11T02:01:00.000Z");
  await notifier.process(notice, "2026-11-11T02:02:00.000Z");
  expect(await logs()).toHaveLength(3);
  expect(await env.DB.prepare("SELECT acknowledged_at FROM alert_state WHERE alert_key=?1").bind(notice.key).first("acknowledged_at")).toBeNull();
});
it("quiet hours use Bangkok time across midnight; held first alert sends when quiet ends", async () => {
  const config = settings();
  config.routing = { submit_error_rate: { telegram: true, repeat_hours: 6, quiet: { from: "22:00", to: "07:00" } } };
  const notifier = new MultiNotifier(env.DB, config, ok);
  await notifier.process(notice, "2026-11-10T16:00:00.000Z");
  expect(await logs()).toHaveLength(0);
  await notifier.process(notice, "2026-11-11T00:00:00.000Z");
  expect(await logs()).toHaveLength(1);
});
it("repeat after six hours and atomic concurrent-send claim", async () => {
  const notifier = new MultiNotifier(env.DB, settings(), ok);
  await Promise.all([notifier.process(notice, at), notifier.process(notice, at)]);
  expect(await logs()).toHaveLength(1);
  await notifier.process(notice, "2026-11-10T07:59:00.000Z");
  expect(await logs()).toHaveLength(1);
  await notifier.process(notice, "2026-11-10T08:00:00.000Z");
  expect(await logs()).toHaveLength(2);
});
it("AdsBot uses a ten-minute cooldown", async () => {
  const notifier = new MultiNotifier(env.DB, settings(), ok);
  await notifier.process(notice, at, 600_000);
  await notifier.process(notice, "2026-11-10T02:09:00.000Z", 600_000);
  expect(await logs()).toHaveLength(1);
  await notifier.process(notice, "2026-11-10T02:10:00.000Z", 600_000);
  expect(await logs()).toHaveLength(2);
});
it("digest contains five numbers and sends only once per Bangkok date", async () => {
  const numbers = { spend: 123.45, leads: 7, cpl: 17.64, sold: 3, profit: 76.55, top_fix: "คอนเวอร์ชันค้าง" };
  const text = formatDigest(numbers, at, "panel.example").text;
  for (const number of ["123.45", "7", "17.64", "3", "76.55"]) expect(text).toContain(number);
  const notifier = new MultiNotifier(env.DB, { ...settings(), digest: { enabled: true, time: "09:00" } }, ok);
  await notifier.digest(numbers, at); await notifier.digest(numbers, at);
  expect(await logs()).toHaveLength(1);
  expect(await env.DB.prepare("SELECT state FROM alert_state").first("state")).toBe("ok");
});
it("message formatting escapes HTML and shows Thai time", () => {
  const formatted = formatNotice({ ...notice, brand: "<b>brand</b>" }, at, "bad/host");
  expect(formatted.text).toContain("&lt;b&gt;brand&lt;/b&gt;");
  expect(formatted.text).toContain("ตรวจพบ 09:00");
  expect(formatted.url).toContain("https://app.aduplift.ai/");
});
it("quiet escalation stays pending until quiet ends, before the repeat interval", async () => {
  const config = settings();
  config.routing = { submit_error_rate: { telegram: true, repeat_hours: 24, quiet: { from: "22:00", to: "07:00" } } };
  const notifier = new MultiNotifier(env.DB, config, ok);
  await notifier.process(notice, "2026-11-10T14:00:00.000Z");
  await notifier.process({ ...notice, level: "alert" }, "2026-11-10T16:00:00.000Z");
  expect(await logs()).toHaveLength(1);
  await notifier.process({ ...notice, level: "alert" }, "2026-11-11T00:00:00.000Z");
  expect(await logs()).toHaveLength(2);
});
it("digest near midnight runs at the next cron tick once for the scheduled Bangkok date", async () => {
  const notifier = new MultiNotifier(env.DB, { ...settings(), digest: { enabled: true, time: "23:59" } }, ok);
  const numbers = { spend: 1, leads: 2, cpl: 0.5, sold: 1, profit: 3, top_fix: "ไม่มี" };
  await notifier.digest(numbers, "2026-11-10T17:00:00.000Z");
  await notifier.digest(numbers, "2026-11-10T17:00:00.000Z");
  expect(await logs()).toHaveLength(1);
  expect(await env.DB.prepare("SELECT alert_key FROM alert_state").first("alert_key")).toBe("digest:2026-11-10");
});
it("conversion notifications are per brand and recovered reports clear their states", async () => {
  const old = "2026-11-09T00:00:00.000Z";
  for (const brand of ["brand-a", "brand-b"]) {
    await insertLead(env.DB, { lead_id: brand, brand, variant: null, keyword: null, created_at: old }).run();
    await insertConversion(env.DB, { lead_id: brand, status: "pending", occurred_at: old, created_at: old }).run();
  }
  const notifier = new MultiNotifier(env.DB, settings(), ok);
  const sources = { submitErrorCounts: new InMemorySubmitErrorCounts([]) };
  await notifier.notify(await runAlerts(env.DB, sources, { now: at }));
  expect((await logs()).map(row => row.alert_key).sort()).toEqual(["conversion_stalled:brand-a", "conversion_stalled:brand-b"]);
  await env.DB.prepare("UPDATE conversion_uploads SET status='uploaded'").run();
  await notifier.notify(await runAlerts(env.DB, sources, { now: "2026-11-10T02:01:00.000Z" }));
  expect((await env.DB.prepare("SELECT state FROM alert_state").all()).results.every(row => row.state === "ok")).toBe(true);
});
