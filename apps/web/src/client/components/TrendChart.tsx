// spec traffic
import type { TrafficReportResponse } from "@anjuna/contracts";
import { EmptyState } from "./EmptyState";

/** Chart geometry in viewBox units: 24 per bucket, values scaled to 100 over a baseline at y 110, 120 high. */
const SLOT = 24;
const SCALE = 100;
const BASELINE = 110;
const HEIGHT = 120;
const TOP = BASELINE - SCALE;

type Bucket = TrafficReportResponse["trend"][number];

/** UTC label read from the ISO string, never from the viewer's time zone. */
function bucketLabel(at: string, bucket: "hour" | "day"): string {
  return bucket === "hour" ? `${at.slice(11, 13)}:00` : at.slice(0, 10);
}

/** Landing views and leads per bucket as inline SVG. Y scales to the largest landing_views or leads value. */
export function TrendChart({ trend, bucket }: { trend: TrafficReportResponse["trend"]; bucket: "hour" | "day" }) {
  const quiet = trend.every((b) => b.landing_views + b.form_starts + b.leads + b.validation_errors + b.redirect_errors === 0);
  if (quiet) return <EmptyState title="ยังไม่มีทราฟฟิกในช่วงนี้" />;
  // Only other metrics may be non-zero, so keep the divisor above 0.
  const most = Math.max(1, ...trend.map((b) => Math.max(b.landing_views, b.leads)));
  const line = (value: (b: Bucket) => number) =>
    trend.map((b, i) => `${i * SLOT + SLOT / 2},${Math.round((BASELINE - (value(b) / most) * SCALE) * 100) / 100}`).join(" ");
  return (
    <>
      <svg className="trend-svg" role="img" aria-label="แนวโน้มทราฟฟิก (Traffic trend)" viewBox={`0 0 ${trend.length * SLOT} ${HEIGHT}`} preserveAspectRatio="none" width="100%" height={HEIGHT}>
        <polyline className="trend-landing" fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" points={line((b) => b.landing_views)} />
        <polyline className="trend-leads" fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" points={line((b) => b.leads)} />
        {trend.map((b, i) => (
          <g key={b.at}>
            <title>{`${bucketLabel(b.at, bucket)}: เข้าชม ${b.landing_views}, เริ่มกรอก ${b.form_starts}, ลีด ${b.leads}, กรอกผิด ${b.validation_errors}, ส่งต่อไม่สำเร็จ ${b.redirect_errors}`}</title>
            {/* A zero bucket draws nothing to hover, so a transparent slot-wide area carries the title. */}
            <rect className="trend-hit" x={i * SLOT} y={TOP} width={SLOT} height={SCALE} fill="transparent" />
          </g>
        ))}
      </svg>
      <p className="trend-axis muted small">เวลา UTC</p>
      <ul className="trend-legend">
        <li><span className="trend-swatch landing" aria-hidden="true" />เข้าชมหน้าแรก (Landing views)</li>
        <li><span className="trend-swatch leads" aria-hidden="true" />ลีด (Leads)</li>
      </ul>
    </>
  );
}
