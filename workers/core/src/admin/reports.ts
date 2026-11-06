/**
 * Read-only admin reports. The panel never binds the leads D1; it calls these routes.
 * Analytics Engine is not wired yet, so /go, form-view and submit-error counts stay empty.
 * Mailing status reads `mailing_outbox` only. It never constructs a listmonk client.
 */
import {
  AlertsReportResponse,
  FunnelReportResponse,
  MailingStatusResponse,
  type AdminRole,
  type AlertsQuery,
  type FunnelQuery,
} from "@anjuna/contracts";
import {
  InMemoryFunnelEvents,
  InMemorySubmitErrorCounts,
  funnelReport,
  runAlerts,
} from "@anjuna/insights";
import type { Env } from "../env.js";
import { loadBotHits } from "./bot-hits.js";
import { listmonkConfigured } from "../listmonk-config.js";

const EMPTY_EVENTS = new InMemoryFunnelEvents([]);
const EMPTY_SUBMIT_ERRORS = new InMemorySubmitErrorCounts([]);

/** Only the owner sees money. Every other role gets `revenue: null` on every row. */
export async function loadFunnel(env: Env, filter: FunnelQuery, role: AdminRole): Promise<FunnelReportResponse> {
  const report = await funnelReport(env.LEADS, EMPTY_EVENTS, filter);
  const shown = role === "owner" ? report : { ...report, rows: report.rows.map((row) => ({ ...row, revenue: null })) };
  return FunnelReportResponse.parse(shown);
}

export async function loadAlerts(env: Env, query: AlertsQuery): Promise<AlertsReportResponse> {
  const now = query.now ?? new Date().toISOString();
  const report = await runAlerts(env.LEADS, { submitErrorCounts: EMPTY_SUBMIT_ERRORS }, { now });
  return AlertsReportResponse.parse({ ...report, bot_hits: await loadBotHits(env, now) });
}

export async function loadMailingStatus(env: Env): Promise<MailingStatusResponse> {
  const { results } = await env.LEADS.prepare(
    "SELECT status, COUNT(*) AS n FROM mailing_outbox GROUP BY status",
  ).all<{ status: string; n: number }>();
  const counts = { pending: 0, sent: 0, skipped: 0, dead: 0 };
  for (const row of results) {
    if (row.status === "pending" || row.status === "sent" || row.status === "skipped" || row.status === "dead") {
      counts[row.status] = Number(row.n);
    }
  }
  return MailingStatusResponse.parse({
    external_sync: listmonkConfigured(env) ? "configured" : "not_configured",
    counts,
  });
}
