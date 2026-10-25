// spec polish
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

const NARROW_QUERY = "(max-width: 767px)";
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** True while the viewport is under 768 px. jsdom has no matchMedia, so it reads false there. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/** The filter controls inline on desktop, behind a Filters button with a modal on phones. Filter state stays in the screen. */
export function FilterBar({ label, activeCount, children }: { label: string; activeCount: number; children: ReactNode }) {
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setOpen(false);
    (openButtonRef.current ?? returnFocus.current)?.focus?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const stops = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (!stops.includes(active as HTMLElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  useEffect(() => {
    if (!open) return;
    // Focus starts inside the modal: first control, or the dialog itself when there is none.
    const wrap = wrapRef.current;
    if (wrap) {
      const stops = Array.from(wrap.querySelectorAll<HTMLElement>(FOCUSABLE));
      (stops[0] ?? wrap).focus();
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open ]);

  // A filter change unmounts the modal with the old controls; never keep it open across renders that swap children.
  useEffect(() => { setOpen(false); }, [narrow]);

  if (!narrow) return <>{children}</>;
  return (
    <>
      <button type="button" className="btn" ref={openButtonRef} onClick={() => { returnFocus.current = document.activeElement as HTMLElement | null; setOpen(true); }}>
        ตัวกรอง (Filters){activeCount > 0 ? ` (${activeCount})` : ""}
      </button>
      {open && (
        <div className="modal-wrap" ref={wrapRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "flex-end", justifyContent: "center", background: "rgba(0,0,0,0.45)", padding: 16 }}>
          <div className="card modal" style={{ width: "100%", maxWidth: 480, maxHeight: "85vh", overflowY: "auto" }}>
            {children}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" className="btn pri" onClick={close}>เสร็จ (Done)</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
