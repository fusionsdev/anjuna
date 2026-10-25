import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

export type RowMenuItem = { key: string; label: string; onSelect: () => void; group?: string; tone?: "danger" };

/** A row-level action menu. Renders nothing for an empty list. Closes on Escape and outside click; arrow keys move focus. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The list is placed with position: fixed from the button rect, so the scrolling table wrapper (.tw) cannot clip it.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const focusItem = (index: number) => {
    const count = items.length;
    itemRefs.current[((index % count) + count) % count]?.focus();
  };

  // An outside mousedown closes the menu; the toggle button handles its own clicks.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    // A fixed list does not follow its button, so scrolling or resizing closes it.
    const onMove = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open ]);
  // Opens below the button, or above it when the list would run off the viewport bottom and fits above.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const list = listRef.current;
    if (!open || !button || !list) { setPos(null); return; }
    const rect = button.getBoundingClientRect();
    const below = rect.bottom + 4;
    const above = rect.top - 4 - list.offsetHeight;
    const top = below + list.offsetHeight > window.innerHeight && above >= 0 ? above : below;
    const left = Math.max(4, Math.min(rect.right - list.offsetWidth, window.innerWidth - list.offsetWidth - 4));
    setPos({ top, left });
  }, [open]);
  // Opening moves focus to the first item so arrow keys work right away.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open ]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (e.key === "Escape") { e.stopPropagation(); close(true); }
    // Tab leaves the menu: focus returns to the button, then the default Tab moves on from there.
    else if (e.key === "Tab") close(true);
    else if (e.key === "ArrowDown") { e.preventDefault(); focusItem(current < 0 ? 0 : current + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(current < 0 ? items.length - 1 : current - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(items.length - 1); }
  };

  let lastGroup: string | undefined;
  if (items.length === 0) return null;
  return <div className="row-menu" ref={wrapRef} onClick={(e) => e.stopPropagation()}
    // Focus moving to another element outside the wrapper closes the menu. A null target (a click on a non-focusable
    // spot, Safari not focusing buttons on click) keeps it open; the outside mousedown handler covers that click.
    onBlur={(e) => { const next = e.relatedTarget as Node | null; if (open && next && !e.currentTarget.contains(next)) setOpen(false); }}>
    <button type="button" className="btn row-action" aria-haspopup="menu" aria-expanded={open}
      ref={buttonRef}
      onClick={(e) => { e.stopPropagation(); setOpen((was) => !was); }}
      onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}>
      {label}
    </button>
    {open && <div className="row-menu-list" role="menu" aria-label={label} onKeyDown={onMenuKeyDown} ref={listRef}
      style={pos ? { position: "fixed", top: pos.top, left: pos.left, right: "auto" } : undefined}>
      {items.map((item, index) => {
        const divider = item.group !== undefined && lastGroup !== undefined && item.group !== lastGroup;
        lastGroup = item.group;
        return <Fragment key={item.key}>
          {divider && <hr className="row-menu-sep" role="separator" />}
          <button type="button" role="menuitem" className={item.tone === "danger" ? "row-menu-item danger" : "row-menu-item"}
            ref={(el) => { itemRefs.current[index] = el; }}
            onClick={(e) => { e.stopPropagation(); setOpen(false); item.onSelect(); }}>
            {item.label}
          </button>
        </Fragment>;
      })}
    </div>}
  </div>;
}
