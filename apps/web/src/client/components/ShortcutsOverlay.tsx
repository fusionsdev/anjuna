import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { SHORTCUTS } from "../useShortcuts";

/**
 * The list of keyboard shortcuts, opened with "?". It is a modal dialog: focus moves to the close button, Tab stays inside,
 * Escape or a click on the scrim closes it, and focus returns to the element that had it before.
 */
export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      // The only control is the close button, so Tab keeps focus on it.
      else if (e.key === "Tab") { e.preventDefault(); close.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (before.current?.isConnected) before.current.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim shortcuts-scrim" onClick={onClose}>
      <section className="shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 id="shortcuts-title">ทางลัดคีย์บอร์ด</h2>
          <button type="button" ref={close} className="shortcuts-close" aria-label="ปิดรายการทางลัด" onClick={onClose}><X size={18} aria-hidden="true" /></button>
        </header>
        <dl>
          {SHORTCUTS.map((row) => (
            <div key={row.keys}><dt><kbd>{row.keys}</kbd></dt><dd>{row.text}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}
