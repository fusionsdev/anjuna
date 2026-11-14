import { ChevronRight } from "lucide-react";
import { type View, isPlainLeftClick, viewPath } from "../router";

type CrumbView = Exclude<View, "not-found">;

/** "ระบบ › เทมเพลต": the sidebar item a page belongs to, as a link back to it, then the page itself. */
export function Breadcrumb({ parent, current, onOpen }: { parent: { id: CrumbView; label: string }; current: string; onOpen: (id: CrumbView) => void }) {
  return (
    <nav className="crumbs" aria-label="ตำแหน่งหน้านี้">
      <a
        href={viewPath(parent.id)}
        onClick={(e) => {
          if (!isPlainLeftClick(e)) return;
          e.preventDefault();
          onOpen(parent.id);
        }}
      >
        {parent.label}
      </a>
      <ChevronRight size={14} aria-hidden="true" />
      <span aria-current="page">{current}</span>
    </nav>
  );
}
