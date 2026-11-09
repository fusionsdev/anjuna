/**
 * T13 Part A3: the owner's allocation tab and the ad_spend_unallocated alert.
 *
 * Source is ad_spend_campaign (migration 0026): the campaign level cost the campaign ingest received for the
 * accounts that several brands share. A campaign is mapped when campaign_brand_map names a brand that is on the
 * same account today, the rule allocateSpend uses; any other campaign is unmapped. Money stays per currency.
 * A day with hourly rows counts only those; a whole-day row counts only for an account, day and currency with
 * no hourly rows, the rule the spend report uses for ad_spend.
 */
import {
  AD_ALLOCATION_WINDOW_DAYS,
  AD_SPEND_UNALLOCATED_ALERT_AT,
  AdAllocationAssignRequest,
  AdAllocationAssignResponse,
  AdAllocationResponse,
  type AdAllocationCampaign,
  type AdminRequestContext,
  type AlertsReportResponse,
  type CampaignMapSource,
  type SpendCostByCurrency,
  type SpendCurrency,
} from "@anjuna/contracts";
import { JOB_BODY_LIMIT, adminError, parseBody } from "./adkit.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { loadAllocationMode, planCampaignSlots } from "./spend.js";

const DAY_MS = 86_400_000;
const ACCOUNT_RE = /^[0-9]{10}$/;

/** First and last UTC day of the window that ends on the day of `now`. */
export function allocationWindow(now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - (AD_ALLOCATION_WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  return { from, to };
}

const CAMPAIGNS_SQL = `
  SELECT c.account, c.campaign_id, c.currency, SUM(c.cost) AS cost, SUM(c.clicks) AS clicks, m.brand_id, m.source
  FROM ad_spend_campaign c
  LEFT JOIN campaign_brand_map m ON m.account = c.account AND m.campaign_id = c.campaign_id
    AND EXISTS (SELECT 1 FROM brand_runtime b WHERE b.brand_id = m.brand_id AND b.google_ads_account = c.account)
  WHERE c.date BETWEEN ?1 AND ?2
    AND (c.hour IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM ad_spend_campaign h
      WHERE h.account = c.account AND h.date = c.date AND h.currency = c.currency AND h.hour IS NOT NULL))
  GROUP BY c.account, c.campaign_id, c.currency`;

const UNALLOCATED_SQL = `
  SELECT u.currency, SUM(u.cost) AS cost
  FROM ad_spend_unallocated u
  WHERE u.date BETWEEN ?1 AND ?2
    AND (u.hour IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM ad_spend_unallocated h
      WHERE h.account = u.account AND h.date = u.date AND h.currency = u.currency AND h.hour IS NOT NULL))
  GROUP BY u.currency`;

interface CampaignRow {
  account: string; campaign_id: string; currency: SpendCurrency; cost: number; clicks: number;
  brand_id: string | null; source: CampaignMapSource | null;
}

/** Hundredths of a stored cost. Every stored part already has 2 decimals, so this only removes float noise. */
const units = (cost: number) => Math.round(Number(cost) * 100);
const zero = (): Record<SpendCurrency, number> => ({ THB: 0, USD: 0 });
const money = (u: Record<SpendCurrency, number>): SpendCostByCurrency => ({ THB: u.THB / 100, USD: u.USD / 100 });

/** Accounts of brand_runtime with two or more brands: account -> sorted brand ids. */
async function sharedAccounts(env: Pick<Env, "LEADS">): Promise<Map<string, string[]>> {
  const { results } = await env.LEADS.prepare(
    "SELECT google_ads_account AS account, brand_id FROM brand_runtime WHERE google_ads_account IS NOT NULL ORDER BY account, brand_id",
  ).all<{ account: string; brand_id: string }>();
  const byAccount = new Map<string, string[]>();
  for (const r of results) {
    if (!ACCOUNT_RE.test(r.account)) continue;
    byAccount.set(r.account, [...(byAccount.get(r.account) ?? []), r.brand_id]);
  }
  return new Map([...byAccount].filter(([, brands]) => brands.length >= 2));
}

interface AccountUnits { account: string; brands: string[]; cost: Record<SpendCurrency, number>; unmapped: Record<SpendCurrency, number> }

/** Campaign rows of the shared accounts in the window, and per account the cost and unmapped cost in hundredths. */
async function readWindow(env: Pick<Env, "LEADS">, now: Date) {
  const { from, to } = allocationWindow(now);
  const shared = await sharedAccounts(env);
  const { results } = await env.LEADS.prepare(CAMPAIGNS_SQL).bind(from, to).all<CampaignRow>();
  const accounts = new Map<string, AccountUnits>(
    [...shared].map(([account, brands]) => [account, { account, brands, cost: zero(), unmapped: zero() }]),
  );
  const campaigns: AdAllocationCampaign[] = [];
  for (const r of results) {
    const entry = accounts.get(r.account);
    if (!entry) continue; // The account is no longer shared: its brand rows are exact and nothing is to assign.
    const u = units(r.cost);
    entry.cost[r.currency] += u;
    if (r.brand_id === null) entry.unmapped[r.currency] += u;
    campaigns.push({
      account: r.account, campaign_id: r.campaign_id, currency: r.currency, cost: u / 100, clicks: Number(r.clicks),
      brand_id: r.brand_id, source: r.brand_id === null ? null : r.source,
    });
  }
  campaigns.sort((a, b) => Number(a.brand_id !== null) - Number(b.brand_id !== null) || b.cost - a.cost
    || a.account.localeCompare(b.account) || a.campaign_id.localeCompare(b.campaign_id) || a.currency.localeCompare(b.currency));
  return { from, to, accounts: [...accounts.values()], campaigns };
}

/** GET /admin/ad-allocation (owner). */
export async function loadAdAllocation(env: Env, now: Date = new Date()): Promise<AdAllocationResponse> {
  const window = await readWindow(env, now);
  const [mode, unallocated] = await Promise.all([
    loadAllocationMode(env),
    env.LEADS.prepare(UNALLOCATED_SQL).bind(window.from, window.to).all<{ currency: SpendCurrency; cost: number }>(),
  ]);
  const unallocatedUnits = zero();
  for (const r of unallocated.results) unallocatedUnits[r.currency] += units(r.cost);
  return AdAllocationResponse.parse({
    mode,
    from: window.from,
    to: window.to,
    accounts: window.accounts.map((a) => ({
      account: a.account, brands: a.brands, cost_by_currency: money(a.cost), unmapped_cost_by_currency: money(a.unmapped),
    })),
    campaigns: window.campaigns,
    unallocated_by_currency: money(unallocatedUnits),
  });
}

type UnallocatedAlert = NonNullable<AlertsReportResponse["ad_spend_unallocated"]>;

/**
 * Alert "ค่าโฆษณายังไม่จัดสรร": one row per shared account and currency whose unmapped cost in the window is
 * above AD_SPEND_UNALLOCATED_ALERT_AT of its cost. The test runs on integer hundredths, so exactly 20 percent
 * does not fire. An account with no cost in a currency has no row for it. Shares only, no money.
 */
export async function loadUnallocatedAlert(env: Pick<Env, "LEADS">, now: string): Promise<UnallocatedAlert> {
  const { accounts } = await readWindow(env, new Date(now));
  // alert_at is 1/5: unmapped / cost > 1/5 is unmapped * 5 > cost, compared on whole hundredths.
  const per = Math.round(1 / AD_SPEND_UNALLOCATED_ALERT_AT);
  const over = (unmapped: number, cost: number) => cost > 0 && unmapped * per > cost;
  const rows: UnallocatedAlert["detail"]["accounts"] = [];
  for (const a of accounts) {
    for (const currency of ["THB", "USD"] as const) {
      if (over(a.unmapped[currency], a.cost[currency])) {
        rows.push({ account: a.account, currency, share: Math.round((a.unmapped[currency] / a.cost[currency]) * 10_000) / 10_000 });
      }
    }
  }
  return {
    state: rows.length > 0 ? "alert" : "ok",
    detail: { window_days: AD_ALLOCATION_WINDOW_DAYS, alert_at: AD_SPEND_UNALLOCATED_ALERT_AT, accounts: rows },
  };
}

/**
 * PATCH /admin/ad-allocation/campaign (owner). Writes `source = 'manual'`, which no click or create write
 * replaces. The brand must be on the account today, and the campaign must have been ingested for the account (404 if
 * not). The stored slots that hold the campaign are allocated again from ad_spend_campaign, so the brand totals
 * move at once: the old estimated shares go, the totals stay exact to 2 decimals, the "~" flag clears.
 */
export async function assignAdCampaign(request: Request, env: Env, context: AdminRequestContext): Promise<Response> {
  const body = await parseBody(request, AdAllocationAssignRequest, JOB_BODY_LIMIT);
  if (!body.ok) {
    if (body.status === 413) return json({ status: "invalid", message: body.message }, 413);
    return adminError(context, { error: "invalid", issues: body.issues ?? [{ path: "body", message: body.message }] });
  }
  const { account, campaign_id, brand_id } = body.data;
  const onAccount = await env.LEADS.prepare("SELECT 1 FROM brand_runtime WHERE brand_id = ?1 AND google_ads_account = ?2")
    .bind(brand_id, account).first();
  if (!onAccount) {
    return adminError(context, { error: "invalid", issues: [{ path: "brand_id", message: "The brand is not on this Google Ads account" }] });
  }
  const ingested = await env.LEADS.prepare("SELECT 1 FROM ad_spend_campaign WHERE account = ?1 AND campaign_id = ?2 LIMIT 1")
    .bind(account, campaign_id).first();
  if (!ingested) return adminError(context, { error: "not_found", resource: "campaign" });
  const before = await env.LEADS.prepare("SELECT brand_id, source FROM campaign_brand_map WHERE account = ?1 AND campaign_id = ?2")
    .bind(account, campaign_id).first<{ brand_id: string; source: string }>();
  const at = new Date().toISOString();
  // The window comes from the server clock only: the PATCH takes no `now`, so a caller cannot move it back to older slots.
  const plan = await planReallocation(env, account, campaign_id, brand_id, allocationWindow(new Date()));
  if ("response" in plan) throw new Error(`re-allocation of account ${account} refused: ${plan.response.status}`);
  // The map row and every re-run statement are one batch: a failing statement leaves the map as it was.
  await env.LEADS.batch([
    env.LEADS.prepare(`
      INSERT INTO campaign_brand_map (account, campaign_id, brand_id, source, first_seen, updated_at)
      VALUES (?1, ?2, ?3, 'manual', ?4, ?4)
      ON CONFLICT (account, campaign_id) DO UPDATE SET brand_id = excluded.brand_id, source = 'manual', updated_at = excluded.updated_at`)
      .bind(account, campaign_id, brand_id, at),
    ...plan.statements,
  ]);
  // The audit row lives in FACTORY, a second database: one batch cannot span both. The LEADS batch above is applied
  // first; if this insert fails the owner gets 500 audit_failed and repeats the PATCH, which is idempotent (it writes
  // the same map row and the same allocation again).
  try {
    await env.FACTORY.prepare(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, 'ad_allocation.assign', 'campaign', ?3, ?4, ?5, ?6)`,
    ).bind(
      context.actor_id, context.actor_role, `${account}:${campaign_id}`,
      before ? JSON.stringify(before) : null, JSON.stringify({ brand_id, source: "manual" }), at,
    ).run();
  } catch {
    return json({ error: "audit_failed", message: "The assignment was applied but its audit entry was not written; repeat the request", request_id: context.request_id }, 500);
  }
  return json(AdAllocationAssignResponse.parse({ account, campaign_id, brand_id, source: "manual", updated_at: at }));
}

interface StoredSlotRow {
  date: string; hour: number | null; campaign_id: string; cost: number; clicks: number; impressions: number;
  currency: SpendCurrency; utc_offset_minutes: number; updated_at: string;
}

/**
 * Statements that allocate the slots of the window that hold the campaign again, per currency and zone, with the
 * stored updated_at of each slot kept. The window is the tab's 7 UTC days ending today, so brand totals match what
 * the tab shows after the new map. spend-sync itself re-posts only yesterday and today. Slots before the window are
 * never touched, so a brand that left the account keeps its older rows.
 */
async function planReallocation(
  env: Env, account: string, campaignId: string, brandId: string, window: { from: string; to: string },
): Promise<{ statements: D1PreparedStatement[] } | { response: Response }> {
  const { results } = await env.LEADS.prepare(`
    SELECT c.date, c.hour, c.campaign_id, c.cost, c.clicks, c.impressions, c.currency, c.utc_offset_minutes, c.updated_at
    FROM ad_spend_campaign c
    WHERE c.account = ?1 AND c.date BETWEEN ?3 AND ?4 AND EXISTS (
      SELECT 1 FROM ad_spend_campaign t
      WHERE t.account = c.account AND t.currency = c.currency AND t.date = c.date
        AND COALESCE(t.hour, -1) = COALESCE(c.hour, -1) AND t.campaign_id = ?2)`)
    .bind(account, campaignId, window.from, window.to).all<StoredSlotRow>();
  const groups = new Map<string, { currency: SpendCurrency; offset: number; rows: StoredSlotRow[] }>();
  for (const row of results) {
    const key = `${row.currency}|${row.utc_offset_minutes}`;
    const group = groups.get(key) ?? { currency: row.currency, offset: Number(row.utc_offset_minutes), rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const statements: D1PreparedStatement[] = [];
  for (const { currency, offset, rows } of groups.values()) {
    const plan = await planCampaignSlots(env, {
      account, currency, offset, deriveMap: false, mapOverride: { campaign_id: campaignId, brand_id: brandId },
      rows: rows.map((r) => ({
        date: r.date, hour: r.hour, campaign_id: r.campaign_id, cost: Number(r.cost), clicks: Number(r.clicks),
        impressions: Number(r.impressions), updated_at: r.updated_at,
      })),
    });
    if ("response" in plan) return plan;
    statements.push(...plan.statements);
  }
  return { statements };
}
