/**
 * Scheduled handlers (CO-7, FA-5). Two Cron Triggers, matched by the exact cron string in
 * wrangler.jsonc: the mailing sync (every 5 minutes) and the alerts check (every 15 minutes).
 * Anything else is ignored, so a trigger added later cannot run the wrong job.
 */
import {
  ConsoleNotifier,
  InMemorySubmitErrorCounts,
  runAlerts,
  type AlertsReport,
  type Notifier,
  type SubmitErrorCountsSource,
} from "@anjuna/insights";
import { ListmonkClient, syncOutbox, syncSuppressions } from "@anjuna/mailing";
import type { Env } from "./env.js";

export const MAILING_CRON = "*/5 * * * *";
export const ALERTS_CRON = "*/15 * * * *";
/** Batches of 50 per run; a larger backlog continues on the next trigger. */
export const MAX_OUTBOX_BATCHES = 5;

export interface CronDeps {
  listmonk?: ListmonkClient;
  notifier?: Notifier;
  submitErrorCounts?: SubmitErrorCountsSource;
}

export interface MailingRunResult {
  ran: boolean;
  reason?: "not_configured" | "invalid_list_map";
  batches?: number;
}

function listMapFrom(raw: string | undefined): Record<string, number> | null {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length === 0 || entries.some(([, id]) => !Number.isInteger(id) || (id as number) <= 0)) return null;
    return parsed as Record<string, number>;
  } catch {
    return null;
  }
}

/** Outbox -> listmonk, then listmonk -> suppressions. Throws on a listmonk outage so the run shows as failed. */
export async function runMailing(env: Env, deps: CronDeps = {}): Promise<MailingRunResult> {
  const listmonk = deps.listmonk ??
    (env.LISTMONK_URL && env.LISTMONK_USER && env.LISTMONK_TOKEN
      ? new ListmonkClient(env.LISTMONK_URL, env.LISTMONK_USER, env.LISTMONK_TOKEN)
      : null);
  if (!listmonk) {
    console.warn("mailing cron skipped: LISTMONK_URL, LISTMONK_USER and LISTMONK_TOKEN are not all set");
    return { ran: false, reason: "not_configured" };
  }
  const listMap = listMapFrom(env.LISTMONK_LIST_MAP);
  if (!listMap) {
    console.error("mailing cron skipped: LISTMONK_LIST_MAP must be a JSON object of brand_id -> positive list id");
    return { ran: false, reason: "invalid_list_map" };
  }

  let batches = 0;
  while (batches < MAX_OUTBOX_BATCHES) {
    batches++;
    if ((await syncOutbox(env.LEADS, listmonk, { listMap })) === 0) break;
  }
  await syncSuppressions(env.LEADS, listmonk, [...new Set(Object.values(listMap))]);
  return { ran: true, batches };
}

/** Runs the four alerts as of `scheduledTime`; the notifier only hears about warn/alert states. */
export async function runAlertsCron(env: Env, scheduledTime: number, deps: CronDeps = {}): Promise<AlertsReport> {
  const report = await runAlerts(
    env.LEADS,
    // Submit error counts come from Analytics Engine later; until then this source is empty (state ok).
    { submitErrorCounts: deps.submitErrorCounts ?? new InMemorySubmitErrorCounts([]) },
    { now: new Date(scheduledTime).toISOString() },
  );
  const states = [
    report.conversion_stalled.state,
    report.brands_without_postbacks.state,
    report.submit_error_rate.state,
    report.reject_rate.state,
  ];
  if (states.some((state) => state !== "ok")) await (deps.notifier ?? new ConsoleNotifier()).notify(report);
  return report;
}

/** B-01 retention: expired duplicate snapshots are cleared even if their token is never claimed. */
export async function purgeExpiredApplicants(env: Env, scheduledTime: number): Promise<void> {
  await env.LEADS.prepare("UPDATE continuations SET applicant_json = NULL WHERE applicant_json IS NOT NULL AND expires_at <= ?1")
    .bind(new Date(scheduledTime).toISOString()).run();
}

export async function handleScheduled(
  controller: { cron: string; scheduledTime: number },
  env: Env,
  deps: CronDeps = {},
): Promise<void> {
  switch (controller.cron) {
    case MAILING_CRON:
      await purgeExpiredApplicants(env, controller.scheduledTime);
      await runMailing(env, deps);
      return;
    case ALERTS_CRON:
      await runAlertsCron(env, controller.scheduledTime, deps);
      return;
    default:
      console.warn(`ignoring unknown cron trigger ${JSON.stringify(controller.cron)}`);
  }
}
