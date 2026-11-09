import type { ReactNode } from "react";
import { useBrandScope } from "../useBrandScope";
import { Chip } from "./Chip";

/**
 * Core adds up some numbers over every brand (conversion totals, the traffic ledger and trend, the funnel breakdown by source,
 * the hourly bars) and has no scope parameter yet. While the brand scope hides brands, a chip "ทุกแบรนด์" sits next to them
 * so nobody reads the figure as the scoped one. With every brand in scope it renders nothing.
 * inline: only the chip, for a heading line. Otherwise the chip and a sentence say which parts follow the scope.
 */
export function AllBrandsNote({ inline = false, children }: { inline?: boolean; children?: ReactNode }) {
  const { hidesBrands } = useBrandScope();
  if (!hidesBrands) return null;
  const chip = <Chip tone="neutral" className="all-brands-chip">ทุกแบรนด์</Chip>;
  if (inline) return <span className="all-brands-note" title="ตัวเลขชุดนี้นับทุกแบรนด์ ยังไม่แยกตามขอบเขตแบรนด์">{chip}</span>;
  return <p className="all-brands-note">{chip}<span className="hint">{children ?? "ตัวเลขชุดนี้นับทุกแบรนด์ ยังไม่แยกตามขอบเขตแบรนด์"}</span></p>;
}
