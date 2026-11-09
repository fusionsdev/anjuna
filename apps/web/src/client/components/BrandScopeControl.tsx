import { ChevronDown, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { SCOPE_GROUPS, type BrandScope } from "../brand-scope";
import { useBrandScope } from "../useBrandScope";

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="scope-switch" onClick={onChange}>
      <span>{label}</span>
      <span className="track" aria-hidden="true"><i /></span>
    </button>
  );
}

/** The button under the logo and the popover it opens: two toggles, a search, brands grouped by state, clear and apply. */
export function BrandScopeControl() {
  const { scope, setScope, list, visibleCount, open, setOpen } = useBrandScope();
  const [hideInactive, setHideInactive] = useState(scope.hideInactive);
  const [showDemo, setShowDemo] = useState(scope.showDemo);
  // null means every brand is ticked. It becomes a list once the user changes a tick, so a refreshed brand list never resets an edit.
  const [selected, setSelected] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const allIds = useMemo(() => (list ?? []).map((entry) => entry.brand.brand_id), [list]);

  // Each opening starts from the applied scope. Only the opening resets the draft: the brand list is read again while the popover is open.
  const applied = useRef(scope);
  applied.current = scope;
  useEffect(() => {
    if (!open) return;
    setHideInactive(applied.current.hideInactive);
    setShowDemo(applied.current.showDemo);
    setSelected(applied.current.brandIds);
    setQuery("");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKey); };
  }, [open, setOpen]);

  const needle = query.trim().toLowerCase();
  const groups = SCOPE_GROUPS.map((group) => ({
    ...group,
    items: (list ?? []).filter((entry) => entry.group === group.id && (!needle || `${entry.brand.name ?? ""} ${entry.brand.hostnames.join(" ")} ${entry.brand.brand_id}`.toLowerCase().includes(needle))),
  })).filter((group) => group.items.length > 0);
  const isTicked = (id: string) => selected === null || selected.includes(id);
  const toggle = (id: string) => setSelected((current) => { const base = current ?? allIds; return base.includes(id) ? base.filter((item) => item !== id) : [...base, id]; });
  const apply = () => {
    const next: BrandScope = { hideInactive, showDemo, brandIds: selected === null || (allIds.length > 0 && allIds.every((id) => selected.includes(id))) ? null : selected };
    setScope(next);
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div ref={root}>
      <button type="button" ref={button} className="scope-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <span>แบรนด์ที่ใช้งาน{visibleCount !== null && <> · <span className="num">{visibleCount}</span></>}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-labelledby={titleId} className="scope-pop">
          <div className="scope-pop-head">
            <h2 id={titleId}>ขอบเขตแบรนด์</h2>
            <button type="button" className="scope-pop-close" aria-label="ปิด" onClick={() => { setOpen(false); button.current?.focus(); }}><X size={16} aria-hidden="true" /></button>
          </div>
          <Switch checked={hideInactive} onChange={() => setHideInactive((value) => !value)} label="ซ่อนแบรนด์ที่ไม่ได้ใช้แล้ว" />
          <Switch checked={showDemo} onChange={() => setShowDemo((value) => !value)} label="แสดงแบรนด์ทดลอง" />
          <label className="scope-search" style={{ position: "relative", marginBottom: 0 }}>
            <span className="sr-only">ค้นหาแบรนด์</span>
            <Search size={16} aria-hidden="true" style={{ position: "absolute", left: 12, top: 14, color: "var(--sub)" }} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ค้นหาชื่อหรือโดเมน" style={{ paddingLeft: 36, width: "100%" }} />
          </label>
          <div className="scope-list">
            {list === null && <p className="hint">ยังโหลดรายการแบรนด์ไม่ได้</p>}
            {groups.map((group) => (
              <section key={group.id} aria-label={group.label}>
                <div className="scope-group-head">
                  <h3>{group.label}</h3>
                  <button type="button" onClick={() => setSelected((current) => Array.from(new Set([...(current ?? allIds), ...group.items.map((entry) => entry.brand.brand_id)])))}>เลือกทั้งหมด</button>
                </div>
                {group.items.map(({ brand }) => (
                  <label key={brand.brand_id} className="scope-item">
                    <input type="checkbox" checked={isTicked(brand.brand_id)} onChange={() => toggle(brand.brand_id)} />
                    <span className="scope-name">{brand.name ?? brand.brand_id}</span>
                    <span className="scope-domain">{brand.hostnames[0]}</span>
                  </label>
                ))}
              </section>
            ))}
          </div>
          <div className="scope-actions">
            <button type="button" className="clear" onClick={() => setSelected([])}>ล้าง</button>
            <button type="button" className="btn pri" onClick={apply}>ใช้</button>
          </div>
        </div>
      )}
    </div>
  );
}
