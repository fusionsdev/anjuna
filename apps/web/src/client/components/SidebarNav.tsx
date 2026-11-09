import { Fragment } from "react";
import type { LucideIcon } from "lucide-react";
import { type View, isPlainLeftClick, viewPath } from "../router";

type NavView = Exclude<View, "not-found">;

/**
 * `activeFor` lists every view that marks the item current (default: its own id). `target` is the view its link opens (default: its own id).
 * `dividerBefore` draws a thin rule above the item. `tag` is a small word after the label, `badge` a count after it.
 */
export type NavItem = {
  id: NavView; label: string; icon?: LucideIcon; tag?: string; dividerBefore?: boolean;
  badge?: { count: number; label: string } | null; activeFor?: NavView[]; target?: NavView;
};

/** The main menu. A closing rule after the last item sets the list off from the user block. */
export function SidebarNav({ items, current, onOpen }: { items: NavItem[]; current: View; onOpen: (id: NavView) => void }) {
  return (
    <nav aria-label="เมนูหลัก">
      {items.map((n) => {
        const target = n.target ?? n.id;
        const views: View[] = n.activeFor ?? [n.id];
        const Icon = n.icon;
        return (
          <Fragment key={n.id}>
            {n.dividerBefore && <div role="separator" className="nav-divider" />}
            <a
              href={viewPath(target)}
              className="nav"
              aria-current={views.includes(current) ? "page" : undefined}
              onClick={(e) => {
                if (!isPlainLeftClick(e)) return;
                e.preventDefault();
                onOpen(target);
              }}
            >
              {Icon && <Icon size={18} aria-hidden="true" />}
              <span>{n.label}</span>
              {n.badge && <b className="num" aria-label={n.badge.label}>{n.badge.count}</b>}
              {n.tag && <small className="nav-tag">{n.tag}</small>}
            </a>
          </Fragment>
        );
      })}
      <div role="separator" className="nav-divider" />
    </nav>
  );
}
