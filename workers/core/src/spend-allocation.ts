/**
 * Split the spend of one Google Ads account between the brands that share it (T13, Part A).
 *
 * A campaign mapped to a brand (campaign_brand_map) gives its whole cost to that brand: `exact`.
 * An unmapped campaign is split across the account's brands by their paid click counts: `estimated`.
 * In `exact_only` mode the unmapped cost goes to no brand and comes back as `unallocated`.
 * All money math runs on integer hundredths (satang or cents) with largest remainder rounding, so the
 * parts of a split add up to the whole exactly.
 */
import type { AdsAllocationMode, SpendAllocation } from "@anjuna/contracts";

/** Clicks of one brand count toward a campaign map row only inside this window. */
export const CAMPAIGN_MAP_WINDOW_DAYS = 30;
/** Fewest clicks of one brand (and none of any other) that map a campaign to it. */
export const CAMPAIGN_MAP_MIN_CLICKS = 3;

/**
 * Split a whole number of units by weights with the largest remainder method. Each part gets the floor
 * of its quota; the units left go one each to the largest fractional parts, ties to the lower index.
 * Every weight 0 means an equal split. The parts always add up to `total`.
 */
export function splitUnits(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError(`splitUnits: total must be a whole number >= 0, got ${total}`);
  if (weights.length === 0) throw new RangeError("splitUnits: no weights");
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new RangeError("splitUnits: weights must be finite and >= 0");
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const wSum = sum > 0 ? sum : weights.length;
  // Click counts are whole numbers: then floor and remainder are exact integer math (total * w stays
  // below 2^53). Other weights use float quotas; the remainder pass still makes the parts add up.
  const exact = w.every(Number.isSafeInteger) && Number.isSafeInteger(total * wSum);
  const parts = w.map((x) => exact ? (total * x - ((total * x) % wSum)) / wSum : Math.floor((total * x) / wSum));
  const frac = w.map((x, i) => exact ? (total * x) % wSum : (total * x) / wSum - parts[i]!);
  let left = total - parts.reduce((a, b) => a + b, 0);
  if (left < 0 || left > w.length) throw new RangeError("splitUnits: rounding left an impossible remainder");
  const order = frac.map((f, i) => ({ i, f })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) parts[order[k]!.i]! += 1;
  return parts;
}

/** Split a money amount by weights on hundredths. Returns numbers with at most 2 decimals that sum to `cost`. */
export function splitCost(cost: number, weights: readonly number[]): number[] {
  return splitUnits(Math.round(cost * 100), weights).map((u) => u / 100);
}

export interface CampaignCost { campaign_id: string; cost: number; clicks: number; impressions: number }
export interface AllocatedRow { brand_id: string; cost: number; clicks: number; impressions: number; allocation: SpendAllocation }

/**
 * Allocate one account's campaign costs for one time slot (one hour, or one whole day) to its brands.
 * `brandClicks` names every brand of the account (a brand with no clicks is 0) and gives the weights
 * for unmapped campaigns. A map row naming a brand outside `brandClicks` counts as unmapped.
 * Rows come sorted by brand, exact before estimated: one exact row per brand that owns a mapped campaign,
 * and one estimated row per brand of the account when any unmapped campaign was split (0 for no clicks).
 * Google clicks and impressions of an unmapped campaign are split with the same weights.
 */
export function allocateSpend(input: {
  campaigns: readonly CampaignCost[];
  map: ReadonlyMap<string, string>;
  brandClicks: Readonly<Record<string, number>>;
  mode: AdsAllocationMode;
}): { rows: AllocatedRow[]; unallocated: number } {
  const brands = Object.keys(input.brandClicks).sort();
  const weights = brands.map((b) => input.brandClicks[b]!);
  type Sum = { cost: number; clicks: number; impressions: number };
  const exact = new Map<string, Sum>();
  const estimated = new Map<string, Sum>();
  let unallocated = 0;
  const add = (into: Map<string, Sum>, brand: string, cost: number, clicks: number, impressions: number) => {
    const s = into.get(brand) ?? { cost: 0, clicks: 0, impressions: 0 };
    s.cost += cost; s.clicks += clicks; s.impressions += impressions;
    into.set(brand, s);
  };
  for (const c of input.campaigns) {
    const cost = Math.round(c.cost * 100);
    const owner = input.map.get(c.campaign_id);
    if (owner !== undefined && Object.hasOwn(input.brandClicks, owner)) {
      add(exact, owner, cost, c.clicks, c.impressions);
    } else if (input.mode === "exact_only" || brands.length === 0) {
      unallocated += cost;
    } else {
      const costs = splitUnits(cost, weights);
      const clicks = splitUnits(c.clicks, weights);
      const impressions = splitUnits(c.impressions, weights);
      brands.forEach((b, i) => add(estimated, b, costs[i]!, clicks[i]!, impressions[i]!));
    }
  }
  const rows: AllocatedRow[] = [];
  for (const brand of brands) {
    for (const [allocation, sums] of [["exact", exact], ["estimated", estimated]] as const) {
      const s = sums.get(brand);
      if (s) rows.push({ brand_id: brand, cost: s.cost / 100, clicks: s.clicks, impressions: s.impressions, allocation });
    }
  }
  return { rows, unallocated: unallocated / 100 };
}

/**
 * Write `source = 'click'` map rows from click_sessions.utm_campaign over the last 30 days before `now`.
 * A numeric campaign id seen on at least 3 clicks of one brand, and on no other brand, maps to that brand
 * under the brand's google_ads_account. A campaign seen on two or more brands stays unmapped, and an
 * earlier `click` row for it is removed. `create` and `manual` rows are never changed.
 * Returns the number of rows inserted or moved to another brand.
 */
export async function deriveCampaignMap(db: D1Database, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - CAMPAIGN_MAP_WINDOW_DAYS * 86_400_000).toISOString();
  const { results } = await db.prepare(`
    SELECT c.utm_campaign AS campaign_id, c.brand_id, b.google_ads_account AS account, COUNT(*) AS n
    FROM click_sessions c LEFT JOIN brand_runtime b ON b.brand_id = c.brand_id
    WHERE c.utm_campaign IS NOT NULL AND c.brand_id IS NOT NULL AND c.click_seen_at >= ?1
      AND length(c.utm_campaign) BETWEEN 1 AND 20 AND c.utm_campaign NOT GLOB '*[^0-9]*'
    GROUP BY c.utm_campaign, c.brand_id`).bind(since).all<{ campaign_id: string; brand_id: string; account: string | null; n: number }>();

  const seen = new Map<string, typeof results>();
  for (const r of results) seen.set(r.campaign_id, [...(seen.get(r.campaign_id) ?? []), r]);
  const map: { account: string; campaign_id: string; brand_id: string }[] = [];
  const conflicted: string[] = [];
  for (const [campaign_id, rows] of seen) {
    if (rows.length > 1) { conflicted.push(campaign_id); continue; }
    const only = rows[0]!;
    if (only.account && Number(only.n) >= CAMPAIGN_MAP_MIN_CLICKS) map.push({ account: only.account, campaign_id, brand_id: only.brand_id });
  }

  const stamp = now.toISOString();
  const statements: D1PreparedStatement[] = [];
  if (conflicted.length) {
    statements.push(db.prepare(`DELETE FROM campaign_brand_map WHERE source = 'click'
      AND campaign_id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(conflicted)));
  }
  if (map.length) {
    statements.push(db.prepare(`
      INSERT INTO campaign_brand_map (account, campaign_id, brand_id, source, first_seen, updated_at)
      SELECT json_extract(value, '$.account'), json_extract(value, '$.campaign_id'), json_extract(value, '$.brand_id'), 'click', ?2, ?2
      FROM json_each(?1) WHERE true
      ON CONFLICT (account, campaign_id) DO UPDATE SET brand_id = excluded.brand_id, updated_at = excluded.updated_at
      WHERE campaign_brand_map.source = 'click' AND campaign_brand_map.brand_id <> excluded.brand_id`)
      .bind(JSON.stringify(map), stamp));
  }
  if (!statements.length) return 0;
  const out = await db.batch(statements);
  return map.length ? Number(out[out.length - 1]!.meta.changes ?? 0) : 0;
}
