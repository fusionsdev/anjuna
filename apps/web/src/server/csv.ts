/**
 * One CSV cell. A leading = + - @ or control character gets a ' so a spreadsheet does not run it
 * as a formula; a cell with a comma, quote or line break is quoted.
 */
export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A header row, then one line per row in column order. Every line, the last included, ends in CRLF. */
export function csvRows(columns: readonly string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell((row[c] as string | number | null | undefined) ?? null)).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
