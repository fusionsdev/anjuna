import { Fragment, useEffect, useRef, useState } from "react";

export type RowMenuItem = { key: string; label: string; onSelect: () => void; group?: string; tone?: "danger" };

/** A row-level action menu. Renders nothing for an empty list. Closes on Escape and outside click; arrow keys move focus. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open ]);
  // Opening moves focus to the first item so arrow keys work right away.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open ]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (e.key === "Escape") { e.stopPropagation(); close(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); focusItem(current < 0 ? 0 : current + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(current < 0 ? items.length - 1 : current - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(items.length - 1); }
  };

  let lastGroup: string | undefined;
  if (items.length === 0) return null;
  return <div className="row-menu" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
    <button type="button" className="btn row-action" aria-haspopup="menu" aria-expanded={open || undefined}
      ref={buttonRef}
      onClick={(e) => { e.stopPropagation(); setOpen((was) => !was); }}
      onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}>
      {label}
    </button>
    {open && <div className="row-menu-list" role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
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
