import type { LeadAggregatesResponse } from "@anjuna/contracts";
import { EmptyState } from "./EmptyState";

export interface DailyCount { day: string; leads: number; sold: number }

const DAY_MS = 86_400_000;
/** Chart geometry in viewBox units: 24 per day, bars scaled to 100 over a baseline at y 110, 120 high. */
const SLOT = 24;
const BAR = 10;
const SCALE = 100;
const BASELINE = 110;
const HEIGHT = 120;

/** One entry per UTC day from `from` to `to`, both included. A day with no row is 0. */
export function dailySeries(response: LeadAggregatesResponse, from: string, to: string): DailyCount[] {
  const byDay = new Map<string, DailyCount>();
  for (const row of response.rows) {
    const entry = byDay.get(row.day) ?? { day: row.day, leads: 0, sold: 0 };
    // `leads` counts every outcome. `sold` counts the outcome "sold" (leads.status soldLead).
    entry.leads += row.count;
    if (row.status === "sold") entry.sold += row.count;
    byDay.set(row.day, entry);
  }
  const first = Date.parse(`${from}T00:00:00.000Z`);
  const count = Math.round((Date.parse(`${to}T00:00:00.000Z`) - first) / DAY_MS) + 1;
  const series: DailyCount[] = [];
  for (let i = 0; i < count; i++) {
    const day = new Date(first + i * DAY_MS).toISOString().slice(0, 10);
    series.push(byDay.get(day) ?? { day, leads: 0, sold: 0 });
  }
  return series;
}

/** Leads and sold per day as inline SVG. Bar height is the count over the largest leads count, so a day with 0 leads gets height 0. */
export function DailyBars({ days }: { days: DailyCount[] }) {
  const most = Math.max(0, ...days.map((d) => d.leads));
  if (most === 0) return <EmptyState title="ยังไม่มีลีดในช่วงนี้" />;
  const height = (count: number) => Math.round((count / most) * SCALE * 100) / 100;
  return (
    <>
      <svg className="bars-svg" role="img" aria-label="ลีดและยอดขายรายวัน" viewBox={`0 0 ${days.length * SLOT} ${HEIGHT}`} preserveAspectRatio="none" width="100%" height={HEIGHT}>
        {days.map((d, i) => (
          <g key={d.day}>
            <title>{`${d.day}: ลีด ${d.leads}, ขายได้ ${d.sold}`}</title>
            <rect className="bar-leads" x={i * SLOT} y={BASELINE - height(d.leads)} width={BAR} height={height(d.leads)} />
            <rect className="bar-sold" x={i * SLOT + BAR + 1} y={BASELINE - height(d.sold)} width={BAR} height={height(d.sold)} />
          </g>
        ))}
      </svg>
      <ul className="bars-legend">
        <li><span className="bars-swatch leads" aria-hidden="true" />ลีด</li>
        <li><span className="bars-swatch sold" aria-hidden="true" />ขายได้</li>
      </ul>
    </>
  );
}
