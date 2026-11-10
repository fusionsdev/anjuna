import { Download } from "lucide-react";
import { type CsvColumn, csvFileName, downloadCsv, toCsv } from "../csv";

/**
 * A button that saves the rows now on screen as a CSV file (UTF-8 with a BOM so Thai opens in Excel). The columns the caller passes
 * are the only ones written, so a role never gets a column its table does not show. It is off while there are no rows.
 */
export function CsvButton<T>({ page, columns, rows }: { page: string; columns: ReadonlyArray<CsvColumn<T>>; rows: ReadonlyArray<T> }) {
  return (
    <button type="button" className="btn csv-button" disabled={rows.length === 0} title={rows.length === 0 ? "ไม่มีแถวให้ส่งออก" : `ส่งออก ${rows.length} แถวที่แสดงอยู่`}
      onClick={() => downloadCsv(csvFileName(page), toCsv(columns, rows))}>
      <Download size={16} aria-hidden="true" />ส่งออก CSV
    </button>
  );
}
