/** One column of a CSV export: its heading and how to read the cell from a row. */
export interface CsvColumn<T> { header: string; value: (row: T) => string | number | null | undefined }

/** The mark Excel needs at the start of a UTF-8 file to read Thai text correctly. */
export const CSV_BOM = "\uFEFF";

/**
 * One CSV field in the form RFC 4180 gives: quoted when it holds a comma, a quote, a line break or a leading or trailing space,
 * with quotes doubled. A text that starts with = + - or @ gets a leading apostrophe, so a spreadsheet reads it as text and not as a
 * formula (a number is written as it is, and a null or undefined value is empty).
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "number" ? String(value) : value;
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The text of a CSV file: the BOM, a heading row, one row per item, lines ended with CRLF. Only the given columns are written. */
export function toCsv<T>(columns: ReadonlyArray<CsvColumn<T>>, rows: ReadonlyArray<T>): string {
  const lines = [columns.map((c) => csvField(c.header)).join(","), ...rows.map((row) => columns.map((c) => csvField(c.value(row))).join(","))];
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

/** The file name of an export: the page and the date (UTC, YYYY-MM-DD). */
export function csvFileName(page: string, now: Date = new Date()): string {
  return `${page}-${now.toISOString().slice(0, 10)}.csv`;
}

/** Hands the text to the browser as a file download. Nothing is sent to the server. */
export function downloadCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
