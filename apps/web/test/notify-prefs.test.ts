import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
let auditBefore: number;
const config = { telegram: { enabled: true, chat_ids: ["123"] }, routing: { adsbot: { telegram: true, repeat_hours: 6, quiet: null } }, digest: { enabled: true, time: "09:00" } };
beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  await env.FACTORY.prepare("DELETE FROM panel_settings").run();
  auditBefore = (await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.notify'").first<number>("n"))!;
  await env.AUTH.prepare("DELETE FROM user_prefs").run();
  owner = await sessions.owner(); employee = await sessions.employee();
});
it("owner writes three settings keys and exactly one audit row", async () => {
  expect((await call("/api/settings/notify", { cookie: owner, method: "PUT", body: config })).status).toBe(200);
  expect(await (await call("/api/settings/notify", { cookie: owner })).json()).toEqual(config);
  expect(await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM panel_settings WHERE key LIKE 'notify.%'").first("n")).toBe(3);
  expect(await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.notify'").first("n")).toBe(auditBefore + 1);
});
it("employee cannot read/write notify, test it or retry a log", async () => {
  for (const [path, method, body] of [
    ["/api/settings/notify", "GET", undefined], ["/api/settings/notify", "PUT", config],
    ["/api/settings/notify/test", "POST", undefined], ["/api/alerts/log/id/retry", "POST", undefined],
  ] as const) expect((await call(path, { cookie: employee, method, ...(body ? { body } : {}) })).status).toBe(403);
  expect(await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.notify'").first("n")).toBe(auditBefore);
});
it("invalid settings leave persisted keys and audit unchanged", async () => {
  expect((await call("/api/settings/notify", { cookie: owner, method: "PUT", body: { ...config, telegram: { ...config.telegram, token: "not-accepted" } } })).status).toBe(422);
  expect(await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM panel_settings").first("n")).toBe(0);
});
it("prefs round-trip for an employee, remain private to that user and require a session", async () => {
  const prefs = { brand_scope: { hide_inactive: false, show_demo: true, brand_ids: ["brand-a"] }, saved_views: { traffic: { period: "7d", source: "google" } } };
  expect((await call("/api/me/prefs", { cookie: employee, method: "PUT", body: prefs })).status).toBe(200);
  expect(await (await call("/api/me/prefs", { cookie: employee })).json()).toEqual(prefs);
  expect(await (await call("/api/me/prefs", { cookie: owner })).json()).toEqual({ brand_scope: { hide_inactive: true, show_demo: false, brand_ids: null }, saved_views: {} });
  expect((await call("/api/me/prefs")).status).toBe(401);
  expect((await call("/api/me/prefs", { cookie: employee, method: "PUT", body: { ...prefs, user_id: "owner" } })).status).toBe(422);
});
it("owner test forwards to private core and returns only provider status", async () => {
  let path = "";
  const binding = { async fetch(request: Request) { path = new URL(request.url).pathname; return Response.json({ status: "sent", response_code: 200 }); } } as unknown as Fetcher;
  const response = await call("/api/settings/notify/test", { cookie: owner, method: "POST", env: makeEnv({ CORE: binding, MOCK_CORE: "0" }) });
  expect(path).toBe("/admin/notifications/test");
  expect(await response.json()).toEqual({ status: "sent", response_code: 200 });
});
/**
 * Core for the nav-counts handler: the brand lists, the alerts report, stored alert states the ack and close calls write,
 * and today's paid and funnel clicks of brand-a for the owner's click loss row.
 */
function navCore(report: unknown, clicks = { paid: 0, reached: 0 }) {
  const at = "2026-11-10T02:00:00.000Z";
  const stored = new Map<string, Record<string, unknown>>();
  return { async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/lifecycle/runtime-list") return Response.json({ brands: [] });
    if (path === "/admin/brands") return Response.json({ brands: [], generated_at: at });
    if (path === "/admin/alerts") return Response.json(report);
    // งานรอทำ reads the dead conversions; none here, so they add no row.
    if (path === "/admin/conversions") return Response.json({ period: "30d", from: at, to: at, totals: { pending: 0, processing: 0, uploaded: 0, dead: 0 }, value_totals: null, stalled: 0, rows: [], truncated: false });
    if (path === "/admin/alerts/state") return Response.json({ rows: [...stored.values()], next_cursor: null });
    if (path === "/admin/spend") return Response.json({ period: "today", from: "2026-11-10", to: "2026-11-10", totals: { cost_by_currency: { THB: 50, USD: 0 }, clicks: clicks.paid, impressions: 900 },
      brands: [{ brand_id: "brand-a", currency: "THB", cost: 50, clicks: clicks.paid, impressions: 900, updated_at: at }], daily: [] });
    if (path === "/admin/funnel") return Response.json({ from: "2026-11-10T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z",
      rows: [{ brand: "brand-a", keyword: null, variant: null, clicks: clicks.reached, go_count: 0, form_views: 0, submits: 0, sold: 0, revenue: 0, submit_rate: null, sold_rate: null }] });
    const action = /^\/admin\/alerts\/([^/]+)\/(ack|close)$/.exec(path);
    if (request.method === "POST" && action) {
      const key = decodeURIComponent(action[1]!);
      const held = stored.get(key);
      const row = { alert_key: key, state: "alert", first_seen: at, last_sent: at, acknowledged_by: action[2] === "ack" ? "employee" : (held?.acknowledged_by ?? null),
        acknowledged_at: action[2] === "ack" ? at : (held?.acknowledged_at ?? null), closed_at: action[2] === "close" ? at : null, updated_at: at };
      stored.set(key, row);
      return Response.json(row);
    }
    return new Response("unexpected", { status: 500 });
  } } as unknown as Fetcher;
}
const healthyReport = {
  generated_at: "2026-11-10T00:00:00.000Z",
  conversion_stalled: { state: "ok", detail: { max_hours: 6, stuck_count: 0, oldest_created_at: null } },
  brands_without_postbacks: { state: "ok", detail: { window_hours: 24, brands: [] } },
  submit_error_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.05, alert_at: 0.1, samples: [] } },
  reject_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [] } },
  click_risk: { state: "ok", detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [] } },
};
it("the alerts badge is the เปิดอยู่ count of /alerts: an acknowledge keeps the row open, a close drops it", async () => {
  // One reject-rate alert for brand-a. /alerts lists an acknowledged row under เปิดอยู่ and a closed row under ปิดแล้ว.
  const report = { ...healthyReport, reject_rate: { state: "alert", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [{ brand: "brand-a", rejected: 5, decided: 10, rate: 0.5 }] } } };
  const binding = navCore(report);
  const options = { cookie: employee, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) };
  expect(await (await call("/api/nav/counts", options)).json()).toEqual({ brands_need_fix: 0, templates_awaiting: 0, alerts_open: 1, tasks_open: 1 });
  expect((await call("/api/alerts/reject_rate%3Abrand-a/ack", { ...options, method: "POST" })).status).toBe(200);
  expect(await (await call("/api/nav/counts", options)).json()).toEqual({ brands_need_fix: 0, templates_awaiting: 0, alerts_open: 1, tasks_open: 1 });
  expect((await call("/api/alerts/reject_rate%3Abrand-a/close", { ...options, method: "POST" })).status).toBe(200);
  expect(await (await call("/api/nav/counts", options)).json()).toEqual({ brands_need_fix: 0, templates_awaiting: 0, alerts_open: 0, tasks_open: 0 });
});
it("a fresh read after an ack and a close lists both stored states through GET /api/alerts/state", async () => {
  const at = "2026-11-10T02:00:00.000Z";
  const stored = new Map<string, Record<string, unknown>>();
  const binding = { async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/admin/alerts/state") return Response.json({ rows: [...stored.values()], next_cursor: null });
    const action = /^\/admin\/alerts\/([^/]+)\/(ack|close)$/.exec(path);
    if (request.method === "POST" && action) {
      const key = decodeURIComponent(action[1]!);
      const row = { alert_key: key, state: "warn", first_seen: at, last_sent: null, acknowledged_by: action[2] === "ack" ? "employee" : null,
        acknowledged_at: action[2] === "ack" ? at : null, closed_at: action[2] === "close" ? at : null, updated_at: at };
      stored.set(key, row);
      return Response.json(row);
    }
    return new Response("unexpected", { status: 500 });
  } } as unknown as Fetcher;
  const options = { cookie: employee, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) };
  expect(await (await call("/api/alerts/state", options)).json()).toEqual({ rows: [], next_cursor: null });
  expect((await call("/api/alerts/adsbot%3Abrand-a/ack", { ...options, method: "POST" })).status).toBe(200);
  expect((await call("/api/alerts/reject_rate%3Abrand-b/close", { ...options, method: "POST" })).status).toBe(200);
  // A new page load is a new GET: both rows come back from the stored copy.
  const fresh = await call("/api/alerts/state", options);
  expect(fresh.status).toBe(200);
  const body = (await fresh.json()) as { rows: Array<{ alert_key: string; acknowledged_at: string | null; closed_at: string | null }> };
  expect(body.rows.map((r) => [r.alert_key, r.acknowledged_at, r.closed_at])).toEqual([["adsbot:brand-a", at, null], ["reject_rate:brand-b", null, at]]);
  expect((await call("/api/alerts/state")).status).toBe(401);
});
it("passes limit and cursor to core and returns its next_cursor", async () => {
  const seen: string[] = [];
  const row = { alert_key: "adsbot:brand-a", state: "warn", first_seen: "2026-11-10T02:00:00.000Z", last_sent: null, acknowledged_by: "employee", acknowledged_at: "2026-11-10T02:00:00.000Z", closed_at: null, updated_at: "2026-11-10T02:00:00.000Z" };
  const binding = { async fetch(request: Request) {
    const target = new URL(request.url);
    seen.push(target.pathname + target.search);
    return Response.json({ rows: [row], next_cursor: '["2026-11-10T02:00:00.000Z","adsbot:brand-a"]' });
  } } as unknown as Fetcher;
  const response = await call("/api/alerts/state?limit=1&cursor=%5B%22a%22%2C%22b%22%5D", { cookie: employee, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) });
  expect(response.status).toBe(200);
  expect(seen).toEqual(["/admin/alerts/state?limit=1&cursor=%5B%22a%22%2C%22b%22%5D"]);
  expect(await response.json()).toEqual({ rows: [row], next_cursor: '["2026-11-10T02:00:00.000Z","adsbot:brand-a"]' });
});
it("answers 502 when core returns a state list that breaks the contract", async () => {
  const binding = { async fetch() { return Response.json({ rows: [{ alert_key: "", state: "nope" }] }); } } as unknown as Fetcher;
  const response = await call("/api/alerts/state", { cookie: employee, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) });
  expect(response.status).toBe(502);
});
it("navigation counts: brands in the saved scope's default view, and templates_awaiting equal to the awaiting_approval rows of the template list", async () => {
  const at = "2026-11-10T02:00:00.000Z";
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands(brand_id,name,account,domain,status,created_by,created_at,updated_at) VALUES ('needs-fix','Broken','account-a','broken.example','failed','owner',?1,?1),('demo3','demo3','account-a','demo3.example','live','owner',?1,?1),('gone','Retired','account-a','gone.example','retired','owner',?1,?1)").bind(at),
    env.FACTORY.prepare("INSERT INTO templates(template_id,name,framework,created_by,created_at,archived_at) VALUES ('awaiting','Awaiting','astro','owner',?1,NULL),('archived','Archived','astro','owner',?1,?1),('second','Second','astro','owner',?1,NULL)").bind(at),
    env.FACTORY.prepare("INSERT INTO template_versions(template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('ready','awaiting',1,'ready-sha','ready','certified','owner',?1),('draft','awaiting',2,'draft-sha','draft','draft','owner',?1),('archived-ready','archived',1,'archived-sha','archived','certified','owner',?1),('second-1','second',1,'second-sha','second','certified','owner',?1)").bind(at),
  ]);
  const binding = navCore(healthyReport);
  const options = { cookie: employee, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) };
  const response = await call("/api/nav/counts", options);
  expect(response.status).toBe(200);
  const counts = await response.json() as { brands_need_fix: number; templates_awaiting: number; alerts_open: number };
  // The default scope hides the demo brand and the retired brand, like the /brands default view.
  expect(counts).toEqual({ brands_need_fix: 1, templates_awaiting: 2, alerts_open: 0, tasks_open: 0 });
  // Owner: the list the Templates screen reads, filtered as /templates?status=awaiting_approval filters it.
  const list = await (await call("/api/templates?include_archived=1", { cookie: owner, env: options.env })).json() as { templates: Array<{ status: string; archived: boolean }> };
  expect(list.templates.filter((t) => !t.archived && t.status === "awaiting_approval")).toHaveLength(counts.templates_awaiting);
  // A saved scope that shows every brand counts all three.
  expect((await call("/api/me/prefs", { cookie: employee, method: "PUT", body: { brand_scope: { hide_inactive: false, show_demo: true, brand_ids: null }, saved_views: {} } })).status).toBe(200);
  expect(((await (await call("/api/nav/counts", options)).json()) as { brands_need_fix: number }).brands_need_fix).toBe(3);
  // A ?scope= link replaces the saved scope: the page opened from it and the badge count the same brands.
  expect((await call("/api/me/prefs", { cookie: employee, method: "PUT", body: { brand_scope: { hide_inactive: true, show_demo: false, brand_ids: null }, saved_views: {} } })).status).toBe(200);
  expect(((await (await call("/api/nav/counts", options)).json()) as { brands_need_fix: number }).brands_need_fix).toBe(1);
  expect(((await (await call("/api/nav/counts?scope=all", options)).json()) as { brands_need_fix: number }).brands_need_fix).toBe(3);
  expect(((await (await call("/api/nav/counts?scope=demo3,gone", options)).json()) as { brands_need_fix: number }).brands_need_fix).toBe(2);
});
it("tasks_open adds the owner's click loss row from today's spend and funnel clicks; an employee gets none", async () => {
  const tasks = async (cookie: string, binding: Fetcher) => ((await (await call("/api/nav/counts", { cookie, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) })).json()) as { tasks_open: number | null }).tasks_open;
  // 141 of 170 paid clicks reached the site: no row. 4 of 170: one row, for the owner only.
  const fine = navCore(healthyReport, { paid: 170, reached: 141 });
  const lossy = navCore(healthyReport, { paid: 170, reached: 4 });
  const ownerFine = await tasks(owner, fine);
  expect(ownerFine).not.toBeNull();
  expect(await tasks(owner, lossy)).toBe(ownerFine! + 1);
  expect(await tasks(employee, lossy)).toBe(await tasks(employee, fine));
  // A failed spend read leaves the owner's count unknown, like any other source of the page.
  const noSpend = { async fetch(request: Request) { return new URL(request.url).pathname === "/admin/spend" ? new Response("down", { status: 503 }) : fine.fetch(request); } } as unknown as Fetcher;
  expect(await tasks(owner, noSpend)).toBeNull();
});
it("a checklist read that throws keeps the route up: the brands badge returns and tasks_open is null", async () => {
  const healthy = navCore(healthyReport);
  const whole = await (await call("/api/nav/counts", { cookie: employee, env: makeEnv({ CORE: healthy, CORE_LIFECYCLE: healthy, MOCK_CORE: "0" }) })).json() as Record<string, number | null>;
  expect(whole.tasks_open).not.toBeNull();
  // Only the batch checklist read uses FACTORY.batch on this route.
  const factory = new Proxy(env.FACTORY, { get(target, key) {
    if (key === "batch") return async () => { throw new Error("D1 unavailable"); };
    const value = Reflect.get(target, key) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const response = await call("/api/nav/counts", { cookie: employee, env: makeEnv({ CORE: healthy, CORE_LIFECYCLE: healthy, MOCK_CORE: "0", FACTORY: factory }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...whole, tasks_open: null });
});
it("navigation counts keep the brands and templates badges and answer alerts_open null when the alert states cannot be read", async () => {
  const healthy = navCore(healthyReport);
  const whole = await call("/api/nav/counts", { cookie: employee, env: makeEnv({ CORE: healthy, CORE_LIFECYCLE: healthy, MOCK_CORE: "0" }) });
  const { brands_need_fix, templates_awaiting, alerts_open } = await whole.json() as { brands_need_fix: number; templates_awaiting: number; alerts_open: number | null };
  expect([whole.status, alerts_open]).toEqual([200, 0]);
  // A page that breaks the contract, a failed page, and a failed alerts report each leave only the alerts badge unknown.
  const broken: Array<(path: string) => Response | null> = [
    (path) => (path === "/admin/alerts/state" ? Response.json({ rows: [{ alert_key: "", state: "nope" }], next_cursor: null }) : null),
    (path) => (path === "/admin/alerts/state" ? new Response("down", { status: 503 }) : null),
    (path) => (path === "/admin/alerts" ? new Response("down", { status: 503 }) : null),
  ];
  for (const fail of broken) {
    const binding = { async fetch(request: Request) { return fail(new URL(request.url).pathname) ?? healthy.fetch(request); } } as unknown as Fetcher;
    const response = await call("/api/nav/counts", { cookie: employee, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) });
    // The งานรอทำ count needs the alerts too, so it is unknown as well.
    expect([response.status, await response.json()]).toEqual([200, { brands_need_fix, templates_awaiting, alerts_open: null, tasks_open: null }]);
  }
});
it("tasks_open is the งานรอทำ row count from task-rows.ts: one per open alert and template, one grouped row for drafts and for dead sales", async () => {
  const at = "2026-11-10T02:00:00.000Z";
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands(brand_id,name,account,domain,status,created_by,created_at,updated_at) VALUES ('draft-a','Drafta','account-a','drafta.example','draft','owner',?1,?1),('draft-b','Draftb','account-a','draftb.example','draft','owner',?1,?1)").bind(at),
    env.FACTORY.prepare("INSERT INTO templates(template_id,name,framework,created_by,created_at,archived_at) VALUES ('tw','Waiting','astro','owner',?1,NULL)").bind(at),
    env.FACTORY.prepare("INSERT INTO template_versions(template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('tw-1','tw',1,'tw-sha','tw','certified','owner',?1),('tw-2','tw',2,'tw2-sha','tw2','certified','owner',?1)").bind(at),
  ]);
  const report = { ...healthyReport, reject_rate: { state: "alert", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [{ brand: "brand-a", rejected: 5, decided: 10, rate: 0.5 }] } } };
  const base = navCore(report);
  const binding = { async fetch(request: Request) {
    if (new URL(request.url).pathname !== "/admin/conversions") return base.fetch(request);
    return Response.json({ period: "30d", from: at, to: at, totals: { pending: 0, processing: 0, uploaded: 0, dead: 3 }, value_totals: null, stalled: 0, rows: [], truncated: true });
  } } as unknown as Fetcher;
  const env2 = makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" });
  // Employee: reject alert + drafts + dead = 3. The owner adds one row per version /templates?status=awaiting_approval lists.
  expect(((await (await call("/api/nav/counts", { cookie: employee, env: env2 })).json()) as { tasks_open: number }).tasks_open).toBe(3);
  const list = await (await call("/api/templates", { cookie: owner, env: env2 })).json() as { templates: Array<{ status: string; archived: boolean }> };
  const awaiting = list.templates.filter((t) => !t.archived && t.status === "awaiting_approval").length;
  expect(awaiting).toBeGreaterThanOrEqual(2);
  expect(((await (await call("/api/nav/counts", { cookie: owner, env: env2 })).json()) as { tasks_open: number }).tasks_open).toBe(3 + awaiting);
});
it("navigation counts answer 502 when the core brand list fails: the brands badge cannot be counted", async () => {
  const healthy = navCore(healthyReport);
  const binding = { async fetch(request: Request) { return new URL(request.url).pathname === "/lifecycle/runtime-list" ? new Response("down", { status: 503 }) : healthy.fetch(request); } } as unknown as Fetcher;
  const response = await call("/api/nav/counts", { cookie: employee, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) });
  expect(response.status).toBe(502);
});
