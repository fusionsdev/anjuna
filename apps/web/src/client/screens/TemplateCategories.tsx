import type { TemplateCategory } from "@anjuna/contracts";
import { Folder, Plus } from "lucide-react";
import { useState } from "react";
import { Chip } from "../components/Chip";

/** "all" shows every template that is not archived; any other value is a category id. Archived templates have their own status chip. */
export type CategoryFilter = "all" | (string & {});

/**
 * Left category list of the template page. Each row shows how many templates (not archived) the category holds.
 * The owner adds a category from the field under the list.
 */
export function CategoryList({ categories, counts, total, filter, onFilter, owner, busy, onCreate }: {
  categories: TemplateCategory[];
  /** Templates per category id, archived ones left out. */
  counts: ReadonlyMap<string, number>;
  total: number;
  filter: CategoryFilter;
  onFilter: (next: CategoryFilter) => void;
  owner: boolean;
  busy: boolean;
  /** Resolves true when the category was created, so the field can clear. */
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const item = (id: CategoryFilter, label: string, count: number) => (
    <li key={id}>
      <button type="button" className="tpl-cat" aria-pressed={filter === id} onClick={() => onFilter(id)}>
        <Folder size={16} aria-hidden="true" />
        <span className="tpl-cat-name">{label}</span>
        <span className="tpl-cat-count">{count}</span>
      </button>
    </li>
  );
  return (
    <nav className="tpl-cats" aria-label="หมวดเทมเพลต">
      <ul>
        {item("all", "ทุกหมวด", total)}
        {categories.map((c) => item(c.id, c.name, counts.get(c.id) ?? 0))}
      </ul>
      {owner && (
        <form className="tpl-cat-add" onSubmit={async (event) => {
          event.preventDefault();
          if (trimmed && await onCreate(trimmed)) setName("");
        }}>
          <input aria-label="ชื่อหมวดใหม่" placeholder="ชื่อหมวดใหม่" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn" disabled={busy || !trimmed}><Plus size={16} aria-hidden="true" />เพิ่มหมวด</button>
        </form>
      )}
    </nav>
  );
}

/** Category of one template. The owner changes it; an employee sees the name only. */
export function TemplateCategoryPicker({ templateName, value, categories, owner, busy, onChange }: {
  templateName: string;
  value: string | null;
  categories: TemplateCategory[];
  owner: boolean;
  busy: boolean;
  onChange: (categoryId: string | null) => void;
}) {
  if (!owner) {
    const current = categories.find((c) => c.id === value);
    return current ? <Chip tone="neutral">{current.name}</Chip> : <span className="hint">ไม่มีหมวด</span>;
  }
  return (
    <select className="tpl-select" aria-label={`หมวดของ ${templateName}`} value={value ?? ""} disabled={busy} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}>
      <option value="">ไม่มีหมวด</option>
      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}
