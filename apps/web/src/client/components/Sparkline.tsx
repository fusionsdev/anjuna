const WIDTH = 96;
const HEIGHT = 28;
const PAD = 2;

/** SVG polyline points for `values`, scaled to the largest value. Fewer than 2 values give no line (empty string). */
export function sparklinePoints(values: number[], width = WIDTH, height = HEIGHT): string {
  if (values.length < 2) return "";
  const most = Math.max(0, ...values);
  const step = width / (values.length - 1);
  return values
    .map((value, i) => {
      const y = most === 0 ? height - PAD : height - PAD - (Math.max(0, value) / most) * (height - 2 * PAD);
      return `${Math.round(i * step * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(" ");
}

/** A small line chart of one value per day, as inline SVG. Draws nothing for fewer than 2 days. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const points = sparklinePoints(values);
  if (!points) return null;
  return (
    <svg className="spark" role="img" aria-label={label} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width={WIDTH} height={HEIGHT} style={{ display: "block", marginTop: 6, color: "var(--spend)" }}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
