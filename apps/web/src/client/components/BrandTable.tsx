import { FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import type { AdsChip, StageStatus } from "../brand-stages";
import { Chip } from "./Chip";
import { StageDots } from "./StageDots";

/** One row of the brand table. Home and Brands build the same row from the same data. */
export interface BrandTableRow {
  id: string;
  /** The first line: the domain, or the name when there is no domain. */
  title: string;
  /** The second line, small. Empty when it would repeat the title. */
  subtitle?: string;
  demo: boolean;
  stages: StageStatus[];
  /** null when the source is not readable by this role (an employee has no spend); the cell shows a dash. */
  ads: AdsChip | null;
  /** Cells that carry money are shown to the owner only; the table leaves their columns out for anyone else. */
  spend: ReactNode;
  leads: ReactNode;
  costPerLead: ReactNode;
  action: { kind: string; label: string; disabled?: boolean; reason?: string; primary: boolean; onClick: () => void };
  /** The row menu (the "⋯" button). Only the Brands screen has one. */
  menu?: ReactNode;
}

/**
 * The brand table of Home and Brands (design BrandTable): brand, seven stage dots, spend, leads, cost per lead, the Google Ads chip and one action.
 * Under 768px the same cells stack as a card per brand (the `.data-table` rule), so there is one DOM and no hidden twin.
 * `data-brand-id`, `data-col` and `data-next-action` name the row, the cell and the action for the tests and for the page's own scripts.
 */
export function BrandTable({ rows, showMoney, compact = false, selectedId, onSelect, label }: {
  rows: BrandTableRow[];
  showMoney: boolean;
  /** Drops the cost per lead column. The Brands screen keeps the table narrow beside its detail panel. */
  compact?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  label: string;
}) {
  const costColumn = showMoney && !compact;
  return (
    <div className="data-table brand-grid-table">
      <table className="brand-table" aria-label={label}>
        <thead>
          <tr>
            <th>แบรนด์</th><th>ระยะ</th>
            {showMoney && <th className="num">ค่าโฆษณา</th>}
            <th className="num">ลีด</th>
            {costColumn && <th className="num">ต้นทุน/ลีด</th>}
            <th>Google Ads</th>
            <th><span className="sr-only">การทำงาน</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = row.id === selectedId;
            return (
              <tr key={row.id} data-brand-id={row.id} className={`${onSelect ? "click " : ""}${selected ? "sel" : ""}`.trim() || undefined} onClick={onSelect ? () => onSelect(row.id) : undefined}>
                <td data-label="แบรนด์" data-col="name">
                  <span className="brand-name">
                    <span className="brand-avatar" aria-hidden="true">{(row.title || "?").charAt(0).toUpperCase()}</span>
                    <span className="brand-name-text">
                      {onSelect
                        ? <button type="button" className="brand-pick" aria-current={selected || undefined}><b>{row.title}</b></button>
                        : <b>{row.title}</b>}
                      {row.demo && <Chip tone="info"><FlaskConical aria-hidden="true" />ทดลอง</Chip>}
                      {row.subtitle && <small className="muted">{row.subtitle}</small>}
                    </span>
                  </span>
                </td>
                <td data-label="ระยะ" data-col="stage"><StageDots stages={row.stages} /></td>
                {showMoney && <td data-label="ค่าโฆษณา" data-col="spend" className="num blue">{row.spend}</td>}
                <td data-label="ลีด" data-col="leads" className="num">{row.leads}</td>
                {costColumn && <td data-label="ต้นทุน/ลีด" data-col="cpl" className="num">{row.costPerLead}</td>}
                <td data-label="Google Ads" data-col="ads">{row.ads ? <Chip tone={row.ads.tone} dot>{row.ads.label}</Chip> : "—"}</td>
                <td data-label="" data-col="action">
                  <span className="row-actions" onClick={(event) => event.stopPropagation()}>
                    <button type="button" className={`btn${row.action.primary ? " pri" : ""} row-action row-primary`} data-next-action={row.action.kind} disabled={row.action.disabled} title={row.action.reason} onClick={row.action.onClick}>{row.action.label}</button>
                    {row.menu}
                    {row.action.reason && <span className="row-reason muted small">{row.action.reason}</span>}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
