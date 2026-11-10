import { useEffect } from "react";

/**
 * Under 768px a table with the class `stack-table` (or `data-table`) shows each row as a card and each cell prints its own column
 * name from `data-label`. Tables written by hand carry no labels, so this reads the head row and sets `data-label` on every body
 * cell that has none. A header with no text (a checkbox or a hidden label) gives an empty label, and a cell that spans the row
 * (an empty-state row) gets an empty label too. Labels already written in the markup are kept.
 */
export function labelStackTables(root: HTMLElement | Document): void {
  for (const table of root.querySelectorAll<HTMLTableElement>(".stack-table table, .data-table table")) {
    const head = table.tHead?.rows[table.tHead.rows.length - 1];
    if (!head) continue;
    const labels = Array.from(head.cells).map((th) => {
      const clone = th.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".sr-only").forEach((hidden) => hidden.remove());
      return (clone.textContent ?? "").trim();
    });
    for (const body of Array.from(table.tBodies)) {
      for (const row of Array.from(body.rows)) {
        Array.from(row.cells).forEach((cell, index) => {
          if (cell.hasAttribute("data-label")) return;
          cell.setAttribute("data-label", cell.colSpan > 1 ? "" : (labels[index] ?? ""));
        });
      }
    }
  }
}

/** Keeps the labels of every stacked table under `root` current while the page renders and changes. */
export function useStackLabels(root: { current: HTMLElement | null }): void {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    labelStackTables(element);
    if (typeof MutationObserver === "undefined") return;
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; labelStackTables(element); });
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root]);
}
