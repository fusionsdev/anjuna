import { useEffect, useRef } from "react";
import type { View } from "./router";

type PageView = Exclude<View, "not-found">;

/** One row of the shortcut list shown by the "?" overlay. */
export const SHORTCUTS: ReadonlyArray<{ keys: string; text: string }> = [
  { keys: "/", text: "ไปที่ช่องค้นหาของหน้านี้" },
  { keys: "g แล้ว h", text: "ไปหน้าแรก" },
  { keys: "g แล้ว b", text: "ไปหน้าแบรนด์" },
  { keys: "g แล้ว t", text: "ไปหน้าเทมเพลต" },
  { keys: "g แล้ว a", text: "ไปหน้าการแจ้งเตือน" },
  { keys: "?", text: "เปิดหรือปิดรายการทางลัดนี้" },
  { keys: "Esc", text: "ปิดหน้าต่างด้านข้าง เมนู และหน้าต่างที่เปิดอยู่" },
];

/** The second key of the chord that starts with g. */
export const GO_TARGETS: Readonly<Record<string, PageView>> = { h: "home", b: "brands", t: "templates", a: "alerts" };
/** How long the second key of a chord may take, in milliseconds. */
export const CHORD_TIMEOUT_MS = 1200;

/** True for an element where a key press is text for the user: a field, a select, or an editable area. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.getAttribute("contenteditable") === "" || target.getAttribute("contenteditable") === "true") return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** The search field of the page on screen: a `[data-page-search]` element first, then the first visible search input in the page content. */
export function findPageSearch(root: HTMLElement | Document = document): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>("[data-page-search], main input[type='search']");
  for (const element of Array.from(candidates)) {
    if (!(element as HTMLInputElement).disabled && !element.closest("[inert]")) return element;
  }
  return null;
}

/**
 * Page shortcuts: "/" focuses the page search, "g" then h, b, t or a goes to a page, "?" toggles the shortcut list.
 * Nothing fires while the user types in a field, a select or an editable area, or while Ctrl, Alt or Meta is held.
 */
export function useShortcuts({ go, toggleHelp }: { go: (view: PageView) => void; toggleHelp: () => void }): void {
  const latest = useRef({ go, toggleHelp });
  latest.current = { go, toggleHelp };
  useEffect(() => {
    let chordAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (isTypingTarget(e.target)) { chordAt = 0; return; }
      const key = e.key;
      if (chordAt && Date.now() - chordAt <= CHORD_TIMEOUT_MS) {
        chordAt = 0;
        const view = GO_TARGETS[key.toLowerCase()];
        if (view) { e.preventDefault(); latest.current.go(view); return; }
      } else {
        chordAt = 0;
      }
      if (key === "g") { chordAt = Date.now(); return; }
      if (key === "/") {
        const search = findPageSearch();
        if (search) { e.preventDefault(); search.focus(); }
        return;
      }
      if (key === "?") { e.preventDefault(); latest.current.toggleHelp(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
