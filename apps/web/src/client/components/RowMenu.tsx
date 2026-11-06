import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

/** disabled with a reason: the item stays in the list, announced as disabled, with the reason as its title. Choosing it does nothing and keeps the menu open. */
export type RowMenuItem = { key: string; label: string; onSelect: () => void; group?: string; tone?: "danger"; disabled?: boolean; reason?: string };

/** A row-level action menu. Renders nothing for an empty list. Closes on Escape and outside click; arrow keys move focus. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The list is placed with position: fixed from the button rect, so the scrolling table wrapper (.tw) cannot clip it.
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  };
  // preventScroll: a focus-induced document scroll would trip the scroll-close handler below.
  const focusItem = (index: number) => {
    const count = items.length;
    const item = itemRefs.current[((index % count) + count) % count];
    item?.focus({ preventScroll: true });
    // Scroll only the list (never the document) so the focused item is visible in a height-clamped list.
    const list = listRef.current;
    if (!item || !list) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  };

  // An outside mousedown closes the menu; the toggle button handles its own clicks.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    // A fixed list does not follow its button, so scrolling or resizing closes it.
    // Scrolling inside the list itself (long list, clamped height) keeps it open.
    // A document scroll event that arrives with the scroll position unchanged since opening (the browser settling
    // after the list renders and takes focus) is not a user scroll, so it keeps the menu open.
    const { scrollX, scrollY } = window;
    const onMove = (e: Event) => {
      if (e.target instanceof Node && listRef.current?.contains(e.target)) return;
      if (e.type === "scroll" && (e.target === document || e.target === e.currentTarget) && window.scrollX === scrollX && window.scrollY === scrollY) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open ]);
  // Opens below the button, or above it when the list does not fit below but fits above. When neither side fits,
  // the list takes the larger side, clamped to the viewport (8 px margin) and scrolls inside.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const list = listRef.current;
    if (!open || !button || !list) { setPos(null); return; }
    const margin = 8;
    const rect = button.getBoundingClientRect();
    const height = list.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom - 4 - margin;
    const spaceAbove = rect.top - 4 - margin;
    let top: number;
    let maxHeight: number;
    if (height <= spaceBelow || (height > spaceAbove && spaceBelow >= spaceAbove)) {
      top = rect.bottom + 4;
      maxHeight = Math.max(0, spaceBelow);
    } else {
      maxHeight = Math.max(0, spaceAbove);
      top = height <= spaceAbove ? rect.top - 4 - height : margin;
    }
    const left = Math.max(4, Math.min(rect.right - list.offsetWidth, window.innerWidth - list.offsetWidth - 4));
    setPos({ top, left, maxHeight });
  }, [open]);
  // The shrink-to-fit width can grow once the list is placed: re-measure and keep the right edge inside the margin.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !pos || !list) return;
    const left = Math.max(4, Math.min(pos.left, window.innerWidth - 8 - list.offsetWidth));
    if (left !== pos.left) setPos({ ...pos, left });
  }, [open, pos]);
  // Opening moves focus to the first item so arrow keys work right away.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus({ preventScroll: true });
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
      style={pos ? { position: "fixed", top: pos.top, left: pos.left, right: "auto", maxHeight: pos.maxHeight, maxWidth: "calc(100vw - 16px)", overflowY: "auto" } : undefined}>
      {items.map((item, index) => {
        const divider = item.group !== undefined && lastGroup !== undefined && item.group !== lastGroup;
        lastGroup = item.group;
        return <Fragment key={item.key}>
          {divider && <hr className="row-menu-sep" role="separator" />}
          {/* aria-disabled, not disabled: a disabled button cannot take focus, so arrow keys would skip the item and a keyboard user would never read its reason. */}
          <button type="button" role="menuitem" className={[item.tone === "danger" ? "row-menu-item danger" : "row-menu-item", item.disabled ? "disabled" : ""].filter(Boolean).join(" ")}
            ref={(el) => { itemRefs.current[index] = el; }}
            aria-disabled={item.disabled || undefined} title={item.disabled ? item.reason : undefined}
            onClick={(e) => { e.stopPropagation(); if (item.disabled) return; setOpen(false); item.onSelect(); }}>
            {item.label}
          </button>
        </Fragment>;
      })}
    </div>}
  </div>;
}
