/**
 * Funnel report data (FA-6): click -> /go -> form view -> submit -> sold -> revenue, grouped by
 * brand x keyword x A/B variant.
 *
 * Clicks, submits, sold and revenue come from the `leads` D1 (packages/leads-db). The /go and
 * form-view counts will come from Analytics Engine later; for now they come from a
 * {@link FunnelEventsSource} (an in-memory fake is provided).
 *
 * All queries are read-only: nothing here writes to D1.
 */
import { z } from "zod";
import { MAX_PAYOUT_USD } from "@anjuna/contracts";

const Timestamp = z.iso.datetime();
const Count = z.number().int().min(0);

export const FunnelFilter = z
  .strictObject({
    from: Timestamp,
    to: Timestamp,
    brand: z.string().min(1).optional(),
    keyword: z.string().min(1).optional(),
    variant: z.string().min(1).optional(),
  })
  .refine((f) => f.from < f.to, "from must be before to");
export type FunnelFilter = z.infer<typeof FunnelFilter>;

/** Counts for one brand x keyword x variant group from the events source (Analytics Engine later). */
export const FunnelEventsRow = z.strictObject({
  brand: z.string().min(1),
  keyword: z.string().min(1).nullable(),
  variant: z.string().min(1).nullable(),
  form_views: Count,
  go_count: Count,
});
export type FunnelEventsRow = z.infer<typeof FunnelEventsRow>;

/** Source of /go and form-view counts, grouped by brand x keyword x variant. */
export interface FunnelEventsSource {
  counts(filter: FunnelFilter): Promise<readonly FunnelEventsRow[]>;
}

/** In-memory source for tests and local development. */
export class InMemoryFunnelEvents implements FunnelEventsSource {
  constructor(private readonly rows: readonly FunnelEventsRow[]) {}

  async counts(filter: FunnelFilter): Promise<FunnelEventsRow[]> {
    const f = FunnelFilter.parse(filter);
    return this.rows.filter(
      (r) =>
        (f.brand === undefined || r.brand === f.brand) &&
        (f.keyword === undefined || r.keyword === f.keyword) &&
        (f.variant === undefined || r.variant === f.variant),
    );
  }
}

/**
 * D1-backed source: every `/go` hit writes a `click_sessions` row with `landing_path = '/go'`,
 * so `go_count` is counted from there. `form_views` has no such row and stays 0 (a separate follow-up).
 * Mirrors {@link queryClicks} for brand-filter host expansion and brand resolution. Only reads.
 */
export class D1FunnelEvents implements FunnelEventsSource {
  constructor(private readonly db: D1Database) {}

  async counts(filter: FunnelFilter): Promise<FunnelEventsRow[]> {
    const f = FunnelFilter.parse(filter);
    const map = await loadBrandMap(this.db);
    const where = ["landing_path = '/go'", "click_seen_at >= ?", "click_seen_at < ?"];
    const params: (string | number)[] = [f.from, f.to];
    if (f.brand !== undefined) {
      const hosts = map.brandToHosts.get(f.brand) ?? [];
      if (hosts.length === 0) return [];
      where.push(`hostname IN (${hosts.map(() => "?").join(", ")})`);
      params.push(...hosts);
    }
    if (f.keyword !== undefined) {
      where.push("keyword = ?");
      params.push(f.keyword);
    }
    if (f.variant !== undefined) {
      where.push("variant = ?");
      params.push(f.variant);
    }
    const sql = `SELECT hostname, variant, keyword, COUNT(*) AS n
                FROM click_sessions
                WHERE ${where.join(" AND ")}
                GROUP BY hostname, variant, keyword`;
    const { results } = await this.db
      .prepare(sql)
      .bind(...params)
      .all<{ hostname: string | null; variant: string | null; keyword: string | null; n: number }>();
    // A /go hit without a hostname cannot be attributed to a brand; drop it, as queryClicks does.
    return results
      .filter((r) => r.hostname !== null && r.hostname.length > 0)
      .map((r) => ({
        brand: map.hostToBrand.get(r.hostname!.toLowerCase()) ?? r.hostname!,
        keyword: r.keyword,
        variant: r.variant,
        form_views: 0,
        go_count: r.n,
      }));
  }
}

/** One funnel row. Rates are null when their denominator is zero. */
export const FunnelRow = z.strictObject({
  brand: z.string().min(1),
  keyword: z.string().min(1).nullable(),
  variant: z.string().min(1).nullable(),
  clicks: Count,
  go_count: Count,
  form_views: Count,
  submits: Count,
  sold: Count,
  revenue: z.number().finite().min(0),
  /** submits / clicks. May exceed 1 when a visitor submits without a tracked click. Null when no clicks. */
  submit_rate: z.number().finite().min(0).nullable(),
  /** sold / submits. Null when no submits. */
  sold_rate: z.number().finite().min(0).nullable(),
});
export type FunnelRow = z.infer<typeof FunnelRow>;

export const FunnelReport = z.strictObject({
  from: Timestamp,
  to: Timestamp,
  rows: z.array(FunnelRow),
});
export type FunnelReport = z.infer<typeof FunnelReport>;

/** `click_sessions` carries a hostname, not a brand; resolve it via `brand_runtime.hostnames`. */
interface BrandMap {
  brandToHosts: Map<string, string[]>;
  hostToBrand: Map<string, string>;
}

async function loadBrandMap(db: D1Database): Promise<BrandMap> {
  const { results } = await db
    .prepare("SELECT brand_id, hostnames FROM brand_runtime")
    .all<{ brand_id: string; hostnames: string }>();
  const brandToHosts = new Map<string, string[]>();
  const hostToBrand = new Map<string, string>();
  for (const row of results) {
    let hosts: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.hostnames);
      if (Array.isArray(parsed)) {
        hosts = parsed
          .filter((h): h is string => typeof h === "string" && h.length > 0)
          .map((h) => h.toLowerCase());
      }
    } catch {
      hosts = [];
    }
    brandToHosts.set(row.brand_id, hosts);
    for (const h of hosts) hostToBrand.set(h, row.brand_id);
  }
  return { brandToHosts, hostToBrand };
}

interface ClickResult {
  brand: string;
  keyword: string | null;
  variant: string | null;
  clicks: number;
}

async function queryClicks(db: D1Database, filter: FunnelFilter, map: BrandMap): Promise<ClickResult[]> {
  const where = ["click_seen_at >= ?", "click_seen_at < ?"];
  const params: (string | number)[] = [filter.from, filter.to];
  if (filter.brand !== undefined) {
    const hosts = map.brandToHosts.get(filter.brand) ?? [];
    if (hosts.length === 0) return [];
    where.push(`hostname IN (${hosts.map(() => "?").join(", ")})`);
    params.push(...hosts);
  }
  if (filter.keyword !== undefined) {
    where.push("keyword = ?");
    params.push(filter.keyword);
  }
  if (filter.variant !== undefined) {
    where.push("variant = ?");
    params.push(filter.variant);
  }
  const sql = `SELECT hostname, variant, keyword, COUNT(*) AS n
              FROM click_sessions
              WHERE ${where.join(" AND ")}
              GROUP BY hostname, variant, keyword`;
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ hostname: string | null; variant: string | null; keyword: string | null; n: number }>();
  // A click without a hostname cannot be attributed to a brand; drop it.
  return results
    .filter((r) => r.hostname !== null && r.hostname.length > 0)
    .map((r) => ({
      brand: map.hostToBrand.get(r.hostname!.toLowerCase()) ?? r.hostname!,
      keyword: r.keyword,
      variant: r.variant,
      clicks: r.n,
    }));
}

interface SubmitResult {
  brand: string;
  keyword: string | null;
  variant: string | null;
  submits: number;
}

async function querySubmits(db: D1Database, filter: FunnelFilter): Promise<SubmitResult[]> {
  const where = ["created_at >= ?", "created_at < ?"];
  const params: (string | number)[] = [filter.from, filter.to];
  if (filter.brand !== undefined) {
    where.push("brand = ?");
    params.push(filter.brand);
  }
  if (filter.keyword !== undefined) {
    where.push("keyword = ?");
    params.push(filter.keyword);
  }
  if (filter.variant !== undefined) {
    where.push("variant = ?");
    params.push(filter.variant);
  }
  const sql = `SELECT brand, variant, keyword, COUNT(*) AS n
              FROM leads
              WHERE ${where.join(" AND ")}
              GROUP BY brand, variant, keyword`;
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ brand: string; variant: string | null; keyword: string | null; n: number }>();
  return results.map((r) => ({ brand: r.brand, keyword: r.keyword, variant: r.variant, submits: r.n }));
}

interface SoldResult {
  brand: string;
  keyword: string | null;
  variant: string | null;
  sold: number;
  revenue: number;
}

async function querySold(db: D1Database, filter: FunnelFilter): Promise<SoldResult[]> {
  // NOTE: the MAX placeholder is the FIRST `?` in the SQL text (inside the SELECT).
  const params: (string | number)[] = [MAX_PAYOUT_USD, filter.from, filter.to];
  const where = ["pe.event_type = 'soldLead'", "pe.payout > 0", "pe.created_at >= ?", "pe.created_at < ?"];
  if (filter.brand !== undefined) {
    where.push("l.brand = ?");
    params.push(filter.brand);
  }
  if (filter.keyword !== undefined) {
    where.push("l.keyword = ?");
    params.push(filter.keyword);
  }
  if (filter.variant !== undefined) {
    where.push("l.variant = ?");
    params.push(filter.variant);
  }
  const sql = `SELECT l.brand AS brand, l.variant AS variant, l.keyword AS keyword,
                     COUNT(*) AS sold,
                     SUM(MIN(pe.payout, ?)) AS revenue
              FROM postback_events pe
              JOIN leads l ON l.lead_id = pe.lead_id
              WHERE ${where.join(" AND ")}
              GROUP BY l.brand, l.variant, l.keyword`;
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ brand: string; variant: string | null; keyword: string | null; sold: number; revenue: number | null }>();
  return results.map((r) => ({
    brand: r.brand,
    keyword: r.keyword,
    variant: r.variant,
    sold: r.sold,
    revenue: r.revenue ?? 0,
  }));
}

interface Cell {
  brand: string;
  keyword: string | null;
  variant: string | null;
  clicks: number;
  go_count: number;
  form_views: number;
  submits: number;
  sold: number;
  revenue: number;
}

function cmpNullable(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function byGroup(a: FunnelRow, b: FunnelRow): number {
  if (a.brand !== b.brand) return a.brand < b.brand ? -1 : 1;
  const k = cmpNullable(a.keyword, b.keyword);
  if (k !== 0) return k;
  return cmpNullable(a.variant, b.variant);
}

/**
 * Build the funnel report grouped by brand x keyword x variant.
 *
 * `events` supplies the /go and form-view counts (Analytics Engine later); clicks, submits,
 * sold and revenue are read from the `leads` D1. Only reads — never writes.
 */
export async function funnelReport(
  db: D1Database,
  events: FunnelEventsSource,
  filter: FunnelFilter,
): Promise<FunnelReport> {
  const f = FunnelFilter.parse(filter);
  const map = await loadBrandMap(db);
  const [clickRows, submitRows, soldRows, eventRows] = await Promise.all([
    queryClicks(db, f, map),
    querySubmits(db, f),
    querySold(db, f),
    events.counts(f),
  ]);

  const cells = new Map<string, Cell>();
  const key = (brand: string, keyword: string | null, variant: string | null) =>
    `${brand}\u0000${keyword ?? ""}\u0000${variant ?? ""}`;
  const touch = (brand: string, keyword: string | null, variant: string | null): Cell => {
    const k = key(brand, keyword, variant);
    let cell = cells.get(k);
    if (!cell) {
      cell = { brand, keyword, variant, clicks: 0, go_count: 0, form_views: 0, submits: 0, sold: 0, revenue: 0 };
      cells.set(k, cell);
    }
    return cell;
  };

  for (const r of clickRows) touch(r.brand, r.keyword, r.variant).clicks += r.clicks;
  for (const r of submitRows) touch(r.brand, r.keyword, r.variant).submits += r.submits;
  for (const r of soldRows) {
    const c = touch(r.brand, r.keyword, r.variant);
    c.sold += r.sold;
    c.revenue += r.revenue;
  }
  for (const e of eventRows) {
    const c = touch(e.brand, e.keyword, e.variant);
    c.form_views += e.form_views;
    c.go_count += e.go_count;
  }

  const rows: FunnelRow[] = [...cells.values()].map((c) => ({
    brand: c.brand,
    keyword: c.keyword,
    variant: c.variant,
    clicks: c.clicks,
    go_count: c.go_count,
    form_views: c.form_views,
    submits: c.submits,
    sold: c.sold,
    revenue: c.revenue,
    submit_rate: c.clicks > 0 ? c.submits / c.clicks : null,
    sold_rate: c.submits > 0 ? c.sold / c.submits : null,
  }));
  rows.sort(byGroup);

  return FunnelReport.parse({ from: f.from, to: f.to, rows });
}