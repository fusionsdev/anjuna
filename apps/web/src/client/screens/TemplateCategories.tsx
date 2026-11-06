import type { TemplateCategory } from "@anjuna/contracts";
import { useState } from "react";

/** "all" shows every template that is not archived, "archived" shows only archived ones, any other value is a category id. */
export type CategoryFilter = "all" | "archived" | (string & {});

/** Category filter for the template list. The owner also adds categories here. */
export function TemplateCategoryBar({ categories, filter, onFilter, owner, busy, onCreate }: {
  categories: TemplateCategory[];
  filter: CategoryFilter;
  onFilter: (next: CategoryFilter) => void;
  owner: boolean;
  busy: boolean;
  /** Resolves true when the category was created, so the field can clear. */
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
      <div className="seg" role="group" aria-label="กรองหมวดเทมเพลต" style={{ flexWrap: "wrap" }}>
        <button type="button" aria-pressed={filter === "all"} onClick={() => onFilter("all")}>ทุกหมวด</button>
        {categories.map((c) => <button type="button" key={c.id} aria-pressed={filter === c.id} onClick={() => onFilter(c.id)}>{c.name}</button>)}
        <button type="button" aria-pressed={filter === "archived"} onClick={() => onFilter("archived")}>เก็บถาวร</button>
      </div>
      {owner && (
        <form className="row" style={{ gap: 8 }} onSubmit={async (event) => {
          event.preventDefault();
          if (trimmed && await onCreate(trimmed)) setName("");
        }}>
          <input aria-label="ชื่อหมวดใหม่" placeholder="ชื่อหมวดใหม่" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn" disabled={busy || !trimmed}>เพิ่มหมวด</button>
        </form>
      )}
    </div>
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
    return current ? <span className="pill p-blue">{current.name}</span> : null;
  }
  return (
    <select aria-label={`หมวดของ ${templateName}`} value={value ?? ""} disabled={busy} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}>
      <option value="">ไม่มีหมวด</option>
      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}
