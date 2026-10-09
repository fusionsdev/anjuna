import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingNotifier } from "@anjuna/insights";
import { ListmonkClient } from "@anjuna/mailing";
import { ALERTS_CRON, MAILING_CRON, MAX_OUTBOX_BATCHES, handleScheduled, runAlertsCron, runMailing } from "../src/cron.js";
import type { Env } from "../src/env.js";
import { createHarness, ROOT, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
beforeEach(async () => {
  await h.reset();
  await h.db.prepare("DELETE FROM suppressions").run();
});
afterAll(async () => { await h?.mf.dispose(); });

class FakeListmonk extends ListmonkClient {
  subscribers = new Map<string, { id: number; email: string; name: string; status: string; attribs?: Record<string, unknown> }>();
  blocklisted: string[] = [];
  down = false;
  constructor() { super("http://listmonk.invalid", "user", "token"); }
  override async findByEmail(email: string) {
    if (this.down) throw new Error("listmonk outage");
    return this.subscribers.get(email) ?? null;
  }
  override async createSubscriber(payload: { email: string; name: string; lists: number[]; attribs: Record<string, unknown> }) {
    if (this.down) throw new Error("listmonk outage");
    const sub = { id: this.subscribers.size + 1, status: "enabled", email: payload.email, name: payload.name, attribs: payload.attribs };
    this.subscribers.set(payload.email, sub);
    return sub;
  }
  override async updateSubscriber(id: number, payload: { name: string; attribs: Record<string, unknown> }) {
    const sub = [...this.subscribers.values()].find((s) => s.id === id)!;
    Object.assign(sub, payload);
    return sub;
  }
  override async getSuppressions(page: number, _perPage: number, reason: "blocklisted" | "unsubscribed") {
    if (this.down) throw new Error("listmonk outage");
    const emails = reason === "blocklisted" && page === 1 ? this.blocklisted : [];
    return { emails, total: emails.length };
  }
}

const env = (extra: Partial<Env> = {}): Env => ({ LEADS: h.db, FACTORY: h.factory, ...extra });
const configured = { LISTMONK_URL: "https://listmonk.example", LISTMONK_USER: "u", LISTMONK_TOKEN: "t", LISTMONK_LIST_MAP: '{"brand-a": 7}' };
const outbox = (leadId: string) => h.db.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES (?1, 'brand-a', datetime('now'))").bind(leadId).run();
const status = (leadId: string) => h.db.prepare("SELECT status, attempts FROM mailing_outbox WHERE lead_id = ?1").bind(leadId).first<{ status: string; attempts: number }>();

describe("wrangler triggers", () => {
  it("declare exactly the two cron strings the handler dispatches on", () => {
    const text = readFileSync(join(ROOT, "workers/core/wrangler.jsonc"), "utf8");
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.triggers).toEqual({ crons: [MAILING_CRON, ALERTS_CRON] });
  });
});

describe("mailing cron", () => {
  it("moves outbox rows to listmonk and syncs suppressions back", async () => {
    await h.seedBrand();
    await h.seedLead("lead-1");
    await outbox("lead-1");
    const listmonk = new FakeListmonk();
    listmonk.blocklisted = ["gone@example.com"];
    const result = await runMailing(env(configured), { listmonk });
    expect(result).toEqual({ ran: true, batches: 2 });
    expect(await status("lead-1")).toMatchObject({ status: "sent" });
    expect(listmonk.subscribers.get("test@example.com")?.attribs).toMatchObject({ brand: "brand-a" });
    const suppressed = await h.db.prepare("SELECT email, reason FROM suppressions").all();
    expect(suppressed.results).toEqual([{ email: "gone@example.com", reason: "blocklisted" }]);
  });

  it("a second run does not re-add anyone", async () => {
    await h.seedBrand();
    await h.seedLead("lead-1");
    await outbox("lead-1");
    const listmonk = new FakeListmonk();
    await runMailing(env(configured), { listmonk });
    await runMailing(env(configured), { listmonk });
    expect(listmonk.subscribers.size).toBe(1);
  });

  it("a listmonk outage fails the run, leaves the row pending and loses no lead", async () => {
    await h.seedBrand();
    await h.seedLead("lead-1");
    await outbox("lead-1");
    const listmonk = new FakeListmonk();
    listmonk.down = true;
    await expect(runMailing(env(configured), { listmonk })).rejects.toThrow(/outage/);
    expect(await status("lead-1")).toEqual({ status: "pending", attempts: 1 });
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM leads").first<{ n: number }>())!.n).toBe(1);
  });

  it("skips cleanly, without any request, when listmonk is not configured or the list map is bad", async () => {
    await h.seedBrand();
    await h.seedLead("lead-1");
    await outbox("lead-1");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runMailing(env())).toEqual({ ran: false, reason: "not_configured" });
    for (const map of ["not json", "[]", "{}", '{"brand-a":"7"}', '{"brand-a":0}']) {
      expect(await runMailing(env({ ...configured, LISTMONK_LIST_MAP: map }))).toEqual({ ran: false, reason: "invalid_list_map" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await status("lead-1")).toEqual({ status: "pending", attempts: 0 });
    vi.restoreAllMocks();
  });

  it("bounds one run to MAX_OUTBOX_BATCHES batches of 50 and leaves the rest for the next trigger", async () => {
    await h.seedBrand();
    const total = MAX_OUTBOX_BATCHES * 50 + 10;
    const values: string[] = [];
    for (let i = 0; i < total; i++) {
      values.push(`('lead-${i}', 'session', 'test', 'lite_v1', 'form-default', 'brand-a', 'brand-a.example', 1000, 'OTHER', 'Test', 'Applicant', '1990-01-01', 'test@example.com', '2145550123', '100 Example St', 'Dallas', 'TX', '75201', 24, 0, 'EMPLOYMENT', 'Example', 'Clerk', 24, '2026-10-09', 'BIWEEKLY', 1, 3000, '{}', '{}', '2026-01-01T00:00:00.000Z', 'cid${i}')`);
    }
    // Seed both tables in one proxy call; per-row calls are slow on Windows.
    await h.db.batch([
      h.db.prepare(`INSERT INTO leads (
      lead_id, session_id, form_version, form_variant, site_id, brand, hostname,
      requested_amount, loan_purpose, first_name, last_name, birth_date, email, home_phone,
      address, city, state, zip, address_length_months, own_home, income_type, employer,
      job_title, employed_months, pay_date1, pay_frequency, direct_deposit, monthly_income,
      tracking_json, metadata_json, created_at, click_id
      ) VALUES ${values.join(",")}`),
      h.db.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) SELECT lead_id, brand, datetime('now') FROM leads"),
    ]);
    const listmonk = new FakeListmonk();
    const result = await runMailing(env(configured), { listmonk });
    expect(result).toEqual({ ran: true, batches: MAX_OUTBOX_BATCHES });
    const pending = await h.db.prepare("SELECT COUNT(*) AS n FROM mailing_outbox WHERE status = 'pending'").first<{ n: number }>();
    expect(pending!.n).toBe(10);
  });
});

describe("alerts cron", () => {
  const SCHEDULED = Date.parse("2026-10-02T12:00:00.000Z");

  it("notifies when something is wrong, with the report as of the scheduled time", async () => {
    await h.seedBrand();
    await h.seedLead("lead-1");
    await h.seedConversion("lead-1", { created_at: "2026-10-02T01:00:00.000Z" }); // pending 11h > 6h
    const notifier = new RecordingNotifier();
    const report = await runAlertsCron(env(), SCHEDULED, { notifier });
    expect(report.generated_at).toBe("2026-10-02T12:00:00.000Z");
    expect(report.conversion_stalled).toMatchObject({ state: "alert", detail: { stuck_count: 1 } });
    expect(notifier.calls).toHaveLength(1);
  });

  it("stays quiet when every alert is ok", async () => {
    const notifier = new RecordingNotifier();
    const report = await runAlertsCron(env(), SCHEDULED, { notifier });
    expect(report.conversion_stalled.state).toBe("ok");
    expect(notifier.calls).toHaveLength(0);
  });

  it("includes submit error counts from the injected source", async () => {
    const notifier = new RecordingNotifier();
    const source = { counts: async () => [{ brand: "brand-a", submits: 80, errors: 20 }] };
    const report = await runAlertsCron(env(), SCHEDULED, { notifier, submitErrorCounts: source });
    expect(report.submit_error_rate.state).toBe("alert");
    expect(notifier.calls).toHaveLength(1);
  });
});

describe("scheduled dispatch", () => {
  it("the mailing cron clears expired duplicate applicant snapshots", async () => {
    await h.seedBrand();
    await h.seedLead("lead-1");
    await h.db.prepare(`INSERT INTO continuations (token_hash, lead_id, brand_id, expires_at, applicant_json)
      VALUES ('expired', 'lead-1', 'brand-a', '2026-10-02T11:00:00.000Z', '{"first_name":"X"}'),
             ('live', 'lead-1', 'brand-a', '2026-10-02T13:00:00.000Z', '{"first_name":"Y"}')`).run();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleScheduled({ cron: MAILING_CRON, scheduledTime: Date.parse("2026-10-02T12:00:00.000Z") }, env({}), {});
    vi.restoreAllMocks();
    expect((await h.db.prepare("SELECT token_hash, applicant_json FROM continuations ORDER BY token_hash").all()).results)
      .toEqual([{ token_hash: "expired", applicant_json: null }, { token_hash: "live", applicant_json: '{"first_name":"Y"}' }]);
  });
  it("routes each cron string to its job and ignores unknown ones", async () => {
    await h.seedBrand();
    await h.seedLead("lead-1");
    await outbox("lead-1");
    await h.seedConversion("lead-1", { created_at: "2026-10-02T01:00:00.000Z" });
    const listmonk = new FakeListmonk();
    const notifier = new RecordingNotifier();
    const scheduledTime = Date.parse("2026-10-02T12:00:00.000Z");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleScheduled({ cron: "0 3 * * *", scheduledTime }, env(configured), { listmonk, notifier });
    expect(listmonk.subscribers.size).toBe(0);
    expect(notifier.calls).toHaveLength(0);

    await handleScheduled({ cron: ALERTS_CRON, scheduledTime }, env(configured), { listmonk, notifier });
    expect(notifier.calls).toHaveLength(1);
    expect(listmonk.subscribers.size).toBe(0);

    await handleScheduled({ cron: MAILING_CRON, scheduledTime }, env(configured), { listmonk, notifier });
    expect(listmonk.subscribers.size).toBe(1);
    expect(notifier.calls).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("the production Worker exposes scheduled() and runs both crons against D1", async () => {
    await h.seedBrand();
    await h.seedLead("lead-1");
    await outbox("lead-1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // The harness forbids external requests, and listmonk is not configured on this Worker: it must skip, not call out.
    const mailing = await h.core.scheduled({ cron: MAILING_CRON, scheduledTime: new Date("2026-10-02T12:00:00.000Z") });
    expect(mailing.outcome).toBe("ok");
    expect(await status("lead-1")).toEqual({ status: "pending", attempts: 0 });
    const alerts = await h.core.scheduled({ cron: ALERTS_CRON, scheduledTime: new Date("2026-10-02T12:00:00.000Z") });
    expect(alerts.outcome).toBe("ok");
    log.mockRestore();
  });
});
