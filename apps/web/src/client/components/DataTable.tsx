import type { ReactNode } from "react";

export type Column<T> = { key: string; header: ReactNode; label?: string; cell: (row: T) => ReactNode; align?: "left" | "right"; mono?: boolean };

export function DataTable<T>({ columns, rows, rowKey, empty, label }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty: ReactNode; label: string }) {
  const cls = (c: Column<T>) => [c.align === "right" ? "num" : "", c.mono ? "mono" : ""].filter(Boolean).join(" ") || undefined;
  const cardLabel = (c: Column<T>) => (c.label !== undefined ? c.label : typeof c.header === "string" ? c.header : "");
  return (
    <div className="tw data-table">
      <table aria-label={label}>
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={cls(c)}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => <tr key={rowKey(row)}>{columns.map((c) => <td key={c.key} className={cls(c)} data-label={cardLabel(c)}>{c.cell(row)}</td>)}</tr>)}
          {rows.length === 0 && <tr><td colSpan={columns.length} data-label="">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
