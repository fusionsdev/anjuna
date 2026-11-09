import { readFileSync, writeFileSync } from "node:fs";

// Run: node workers/core/test/fixtures/compute-expected.mjs [--check]
// NDJSON is the strict public tail envelope. Private synthetic seed data stays in
// the context sidecar. No previous-day events are seeded: every delta is null.
const read = name => readFileSync(new URL(name, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const events = read("traffic-events.ndjson").trim().split(/\r?\n/).map(JSON.parse);
const context = JSON.parse(read("traffic-events.context.json"));
const hour = ts => new Date(ts).toISOString().slice(0, 13) + ":00:00.000Z";
const to = context.now;
const from = hour(Date.parse(to) - 23 * 3_600_000);
const rows = events.filter(e => e.ts >= Date.parse(from) && e.ts < Date.parse(to));
const prior = events.filter(e => e.ts >= Date.parse(from) - 86_400_000 && e.ts < Date.parse(to) - 86_400_000);
const data = e => context.events[e.event_id];
const pct = (n, total) => total ? n * 100 / total : 0;
const metricTypes = { landing_views: "landing_viewed", form_starts: "form_started", leads: "lead_submitted",
  validation_errors: "form_validation_failed", redirect_errors: "redirect_failed" };
const metrics = list => Object.fromEntries(Object.entries(metricTypes).map(([key, type]) => [key, list.filter(e => e.event_type === type).length]));
function kpis(list, end) {
  const totals = metrics(list);
  const missing = list.filter(e => e.event_type === "landing_viewed" && !data(e).gclid?.trim()).length;
  const countries = list.filter(e => data(e).country);
  const drops = list.filter(e => e.event_type === "gate_viewed" && !events.some(next =>
    next.domain === e.domain && data(next).session_id === data(e).session_id && next.ts >= e.ts && next.ts < end &&
    ["landing_viewed", "form_started"].includes(next.event_type)));
  const sessions = list => new Set(list.map(e => `${e.domain}:${data(e).session_id}`)).size;
  return { ...totals, suspicious_sessions: sessions(list.filter(e => data(e).risk_score >= 50)),
    no_gclid_landings: { count: missing, pct: pct(missing, totals.landing_views) }, gate_drops: sessions(drops),
    non_us_pct: countries.length ? pct(countries.filter(e => data(e).country !== "US").length, countries.length) : null };
}
const current = kpis(rows, Date.parse(to));
const previous = kpis(prior, Date.parse(to) - 86_400_000);
const scalar = value => typeof value === "object" && value !== null ? value.count : value;
const deltas = Object.fromEntries(Object.keys(current).map(key => {
  const a = scalar(current[key]), b = scalar(previous[key]);
  return [key, a === null || b === null || b === 0 ? null : (a - b) * 100 / b];
}));
const dimensions = { source: e => data(e).source, hostname: e => e.domain, device: e => e.device_type,
  browser: e => e.browser, brand: e => e.brand };
const breakdowns = Object.fromEntries(Object.entries(dimensions).map(([name, keyOf]) => {
  const counts = new Map();
  for (const e of rows) { const key = keyOf(e) || "unknown"; counts.set(key, (counts.get(key) ?? 0) + 1); }
  return [name, [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, 10).map(([key, count]) => ({ key, count, pct: pct(count, rows.length) }))];
}));
const bots_now = Object.fromEntries(["googlebot", "adsbot", "other-bot"].map(kind => {
  const hits = rows.filter(e => e.user_agent_family === kind);
  return [kind, { current_hour: hits.filter(e => hour(e.ts) === hour(Date.parse(to))).length, "24h": hits.length }];
}));
const descending = [...rows].sort((a, b) => b.ts - a.ts || b.event_id.localeCompare(a.event_id));
const expected = { period: "24h", from, to, kpis: current, deltas, bots_now,
  // D1 stores neither HTTP status, duration nor gate outcome. The tail fixture
  // retains the 500; the report must not pretend these fields were persisted.
  adsbot_last: descending.filter(e => e.user_agent_family === "adsbot").slice(0, 20).map(e => ({
    brand: e.brand, url: e.url, at: new Date(e.ts).toISOString(), http_status: null, response_ms: null, gate_passed: null })),
  breakdowns,
  trend: [...new Set(rows.map(e => hour(e.ts)))].sort().map(at => {
    const m = metrics(rows.filter(e => hour(e.ts) === at));
    return { at, landing_views: m.landing_views, form_starts: m.form_starts, leads: m.leads };
  }),
  recent: descending.slice(0, 200).map(e => ({ at: new Date(e.ts).toISOString(), event_type: e.event_type,
    hostname: e.domain, brand: e.brand, source: data(e).source, campaign: data(e).campaign,
    device: e.device_type, browser: e.browser, form_step: data(e).form_step, error_code: data(e).error_code,
    session_ref: e.session_ref, user_agent_family: e.user_agent_family })),
};
const output = JSON.stringify(expected, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (read("traffic-events.expected.json") !== output) throw new Error("Stale traffic-events.expected.json; regenerate it");
  console.log("traffic-events.expected.json is current");
} else {
  writeFileSync(new URL("traffic-events.expected.json", import.meta.url), output);
  console.log(JSON.stringify({ kpis: current, bots_now }));
}
