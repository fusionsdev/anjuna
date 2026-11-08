import { type View, isPlainLeftClick, viewPath } from "../router";

type TabView = Exclude<View, "not-found">;

/** The sub-pages of one sidebar group. Each tab is a link to its own URL, so a new tab or a reload keeps the screen. */
export function SectionTabs({ tabs, active, onSelect, label = "หมวดย่อย" }: {
  tabs: { id: TabView; label: string }[];
  active: View | null;
  onSelect: (id: TabView) => void;
  label?: string;
}) {
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={viewPath(tab.id)}
          className="section-tab"
          aria-current={active === tab.id ? "page" : undefined}
          onClick={(e) => {
            if (!isPlainLeftClick(e)) return;
            e.preventDefault();
            onSelect(tab.id);
          }}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
