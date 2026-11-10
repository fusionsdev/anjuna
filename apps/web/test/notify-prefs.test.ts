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
it("employee acknowledgement drops the navigation badge through the state API", async () => {
  let acknowledged = false;
  const at = "2026-11-10T02:00:00.000Z";
  const binding = { async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/lifecycle/runtime-list") return Response.json({ brands: [] });
    if (path === "/admin/alerts/open-count") return Response.json({ alerts_open: acknowledged ? 0 : 1 });
    if (path === "/admin/alerts/adsbot%3Abrand-a/ack") {
      acknowledged = true;
      return Response.json({ alert_key: "adsbot:brand-a", state: "warn", first_seen: at, last_sent: at, acknowledged_by: "employee",
        acknowledged_at: at, closed_at: null, updated_at: at });
    }
    return new Response("unexpected", { status: 500 });
  } } as unknown as Fetcher;
  const options = { cookie: employee, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) };
  expect(await (await call("/api/nav/counts", options)).json()).toEqual({ brands_need_fix: 0, templates_awaiting: 0, alerts_open: 1 });
  expect((await call("/api/alerts/adsbot%3Abrand-a/ack", { ...options, method: "POST" })).status).toBe(200);
  expect(await (await call("/api/nav/counts", options)).json()).toEqual({ brands_need_fix: 0, templates_awaiting: 0, alerts_open: 0 });
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
it("navigation counts reuse brand health and count only unarchived certified templates", async () => {
  const at = "2026-11-10T02:00:00.000Z";
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands(brand_id,name,account,domain,status,created_by,created_at,updated_at) VALUES ('needs-fix','Broken','account-a','broken.example','failed','owner',?1,?1)").bind(at),
    env.FACTORY.prepare("INSERT INTO templates(template_id,name,framework,created_by,created_at,archived_at) VALUES ('awaiting','Awaiting','astro','owner',?1,NULL),('archived','Archived','astro','owner',?1,?1)").bind(at),
    env.FACTORY.prepare("INSERT INTO template_versions(template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('ready','awaiting',1,'ready-sha','ready','certified','owner',?1),('draft','awaiting',2,'draft-sha','draft','draft','owner',?1),('archived-ready','archived',1,'archived-sha','archived','certified','owner',?1)").bind(at),
  ]);
  const binding = { async fetch(request: Request) {
    return new URL(request.url).pathname === "/lifecycle/runtime-list" ? Response.json({ brands: [] }) : Response.json({ alerts_open: 0 });
  } } as unknown as Fetcher;
  const response = await call("/api/nav/counts", { cookie: employee, env: makeEnv({ CORE: binding, CORE_LIFECYCLE: binding, MOCK_CORE: "0" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ brands_need_fix: 1, templates_awaiting: 1, alerts_open: 0 });
});
