/** The window of equal length that ends where `range` starts. Both ends are ISO instants. */
export function previousRange(range: { from: string; to: string }): { from: string; to: string } {
  const length = Date.parse(range.to) - Date.parse(range.from);
  return { from: new Date(Date.parse(range.from) - length).toISOString(), to: range.from };
}

/** Percent change from `previous` to `current`. `null` while either value loads (`undefined`); a dash when there is nothing to compare. */
export function delta(current: number | null | undefined, previous: number | null | undefined) {
  if (current === undefined || previous === undefined) return null;
  if (current === null || previous === null || previous === 0) return { text: "–", dir: "flat" as const };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "0%", dir: "flat" as const };
  return pct > 0 ? { text: `▲ ${pct}%`, dir: "up" as const } : { text: `▼ ${Math.abs(pct)}%`, dir: "down" as const };
}
