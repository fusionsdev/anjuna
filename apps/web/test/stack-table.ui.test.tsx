import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { labelStackTables } from "../src/client/stack-labels";

const css = readFileSync(join(__dirname, "../src/client/styles.css"), "utf8").replace(/\r\n/g, "\n");
afterEach(cleanup);

describe("stacked cards under 768px", () => {
  it("has one shared mobile rule block for .data-table and .stack-table with the card layout", () => {
    const start = css.indexOf("@media (max-width: 767px) {\n  :is(.data-table, .stack-table)");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("\n}\n", start));
    expect(block).toContain("td::before { content: attr(data-label)");
    expect(block).toContain("display: flex");
    expect(block).toContain("clip: rect(0 0 0 0)");
    expect(block).toMatch(/min-height: 44px/);
    expect(block).toContain("html, body { overflow-x: hidden; }");
  });

  it("restores the natural row height after the 52px row rule, so stacked rows never overlap", () => {
    const rowRule = css.indexOf(".table tbody tr, .data-table tbody tr { height: var(--row-h); }");
    const mobileRule = css.indexOf(".table tbody tr, .data-table tbody tr, .stack-table tbody tr { height: auto; }");
    expect(rowRule).toBeGreaterThan(-1);
    expect(mobileRule).toBeGreaterThan(rowRule);
  });

  it("beats a screen sheet that fixes a cell height or nowrap, with a longer selector", () => {
    expect(css).toContain(":is(.data-table, .stack-table) tbody tr td { height: auto; white-space: normal;");
  });
});

describe("labelStackTables", () => {
  const html = (inner: string) => `<div class="tw stack-table"><table>${inner}</table></div>`;

  it("copies each header text into the data-label of the cell in the same column", () => {
    const { container } = render(<div dangerouslySetInnerHTML={{ __html: html("<thead><tr><th>แบรนด์</th><th>สถานะ</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody>") }} />);
    labelStackTables(container);
    expect([...container.querySelectorAll("td")].map((td) => td.getAttribute("data-label"))).toEqual(["แบรนด์", "สถานะ"]);
  });

  it("gives an empty label to a column with no header text or only a hidden one, and to a row that spans", () => {
    const { container } = render(<div dangerouslySetInnerHTML={{ __html: html('<thead><tr><th><input type="checkbox"></th><th>ชื่อ</th><th><span class="sr-only">การทำงาน</span></th></tr></thead><tbody><tr><td></td><td>x</td><td></td></tr><tr><td colspan="3">ว่าง</td></tr></tbody>') }} />);
    labelStackTables(container);
    const labels = [...container.querySelectorAll("td")].map((td) => td.getAttribute("data-label"));
    expect(labels).toEqual(["", "ชื่อ", "", ""]);
  });

  it("keeps a label written in the markup and ignores tables that are not stacked", () => {
    const { container } = render(<div dangerouslySetInnerHTML={{ __html: html('<thead><tr><th>หัว</th></tr></thead><tbody><tr><td data-label="เขียนเอง">a</td></tr></tbody>') + "<table><thead><tr><th>x</th></tr></thead><tbody><tr><td>y</td></tr></tbody></table>" }} />);
    labelStackTables(container);
    const cells = container.querySelectorAll("td");
    expect(cells[0]!.getAttribute("data-label")).toBe("เขียนเอง");
    expect(cells[1]!.hasAttribute("data-label")).toBe(false);
  });
});
