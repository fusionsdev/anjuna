/**
 * Read-only admin reports. The panel never binds the leads D1; it calls these routes.
 * /go is measured from click_sessions (landing_path = '/go'); form-view and submit-error counts stay
 * empty until Analytics Engine is wired. Mailing status reads `mailing_outbox` only. It never constructs a listmonk client.
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
  D1FunnelEvents,
  InMemorySubmitErrorCounts,
  funnelReport,
  runAlerts,
} from "@anjuna/insights";
import type { Env } from "../env.js";
import { loadBotHits } from "./bot-hits.js";
import { loadUnallocatedAlert } from "../ad-allocation.js";
import { listmonkConfigured } from "../listmonk-config.js";

const EMPTY_SUBMIT_ERRORS = new InMemorySubmitErrorCounts([]);

/** Only the owner sees money. Every other role gets `revenue: null` on every row. */
export async function loadFunnel(env: Env, filter: FunnelQuery, role: AdminRole): Promise<FunnelReportResponse> {
  const report = await funnelReport(env.LEADS, new D1FunnelEvents(env.LEADS), filter);
  const shown = role === "owner" ? report : { ...report, rows: report.rows.map((row) => ({ ...row, revenue: null })) };
  return FunnelReportResponse.parse(shown);
}

export async function loadAlerts(env: Env, query: AlertsQuery): Promise<AlertsReportResponse> {
  const now = query.now ?? new Date().toISOString();
  const report = await runAlerts(env.LEADS, { submitErrorCounts: EMPTY_SUBMIT_ERRORS }, { now });
  // The crawler block is extra: a failed read omits it and never breaks the alerts report.
  const bot_hits = await loadBotHits(env, now).catch(() => undefined);
  // T13 A3: same rule, a failed read omits the block.
  const ad_spend_unallocated = await loadUnallocatedAlert(env, now).catch(() => undefined);
  return AlertsReportResponse.parse({
    ...report,
    ...(bot_hits ? { bot_hits } : {}),
    ...(ad_spend_unallocated ? { ad_spend_unallocated } : {}),
  });
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
