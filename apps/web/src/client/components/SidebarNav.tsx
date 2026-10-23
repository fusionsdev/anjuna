import { type View, isPlainLeftClick, viewPath } from "../router";

export type NavItem = { id: Exclude<View, "not-found">; label: string; badge?: { count: number; label: string } | null; gap?: boolean };

export function SidebarNav({ items, current, onOpen }: { items: NavItem[]; current: View; onOpen: (id: NavItem["id"]) => void }) {
  return (
    <nav aria-label="เมนูหลัก">
      {items.map((n) => (
        <a
          key={n.id}
          href={viewPath(n.id)}
          className={`nav${n.gap ? " navgap" : ""}`}
          aria-current={current === n.id ? "page" : undefined}
          onClick={(e) => {
            if (!isPlainLeftClick(e)) return;
            e.preventDefault();
            onOpen(n.id);
          }}
        >
          <span>{n.label}</span>
          {n.badge && <b aria-label={n.badge.label}>{n.badge.count}</b>}
        </a>
      ))}
    </nav>
  );
}
