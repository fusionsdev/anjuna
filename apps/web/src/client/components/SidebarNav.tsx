import { type View, isPlainLeftClick, viewPath } from "../router";

type NavView = Exclude<View, "not-found">;

/** `activeFor` lists every view that marks the item current (default: its own id). `target` is the view its link opens (default: its own id). */
export type NavItem = { id: NavView; label: string; badge?: { count: number; label: string } | null; gap?: boolean; activeFor?: NavView[]; target?: NavView };

export function SidebarNav({ items, current, onOpen }: { items: NavItem[]; current: View; onOpen: (id: NavView) => void }) {
  return (
    <nav aria-label="เมนูหลัก">
      {items.map((n) => {
        const target = n.target ?? n.id;
        const views: View[] = n.activeFor ?? [n.id];
        return (
          <a
            key={n.id}
            href={viewPath(target)}
            className={`nav${n.gap ? " navgap" : ""}`}
            aria-current={views.includes(current) ? "page" : undefined}
            onClick={(e) => {
              if (!isPlainLeftClick(e)) return;
              e.preventDefault();
              onOpen(target);
            }}
          >
            <span>{n.label}</span>
            {n.badge && <b aria-label={n.badge.label}>{n.badge.count}</b>}
          </a>
        );
      })}
    </nav>
  );
}
