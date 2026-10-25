// spec polish
import { type ReactNode, useEffect, useState } from "react";

const NARROW_QUERY = "(max-width: 767px)";

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open ]);

  // A filter change unmounts the modal with the old controls; never keep it open across renders that swap children.
  useEffect(() => { setOpen(false); }, [narrow]);

  if (!narrow) return <>{children}</>;
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        ตัวกรอง (Filters){activeCount > 0 ? ` (${activeCount})` : ""}
      </button>
      {open && (
        <div className="modal-wrap" role="dialog" aria-modal="true" aria-label={label} style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "flex-end", justifyContent: "center", background: "rgba(0,0,0,0.45)", padding: 16 }}>
          <div className="card modal" style={{ width: "100%", maxWidth: 480, maxHeight: "85vh", overflowY: "auto" }}>
            {children}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" className="btn pri" onClick={() => setOpen(false)}>เสร็จ (Done)</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
