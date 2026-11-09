import { BRAND_CHIPS, BRAND_SORTS, type BrandChip, type BrandSortMode } from "../brand-health";
import { Search } from "lucide-react";

// Chips first, then one row with the search, the sort and the demo toggle (design Brands page).
// showDemo: the "แสดงแบรนด์ทดลอง" box. Brands named demo<digits> stay out of the list until it is on.
export function BrandFilters({ chip, onChip, counts, sort, onSort, owner, search, onSearch, showDemo, onShowDemo }: {
  chip: BrandChip; onChip: (chip: BrandChip) => void; counts: Record<BrandChip, number>;
  sort: BrandSortMode; onSort: (mode: BrandSortMode) => void; owner: boolean;
  search: string; onSearch: (value: string) => void;
  showDemo: boolean; onShowDemo: (value: boolean) => void;
}) {
  return <div className="brand-filters">
    <div className="brand-chips" role="group" aria-label="ตัวกรองแบรนด์">
      {BRAND_CHIPS.map(({ id, label }) => <button key={id} type="button" className="brand-chip" aria-pressed={chip === id} onClick={() => onChip(id)}>
        {label} <span className="brand-chip-count num">{counts[id]}</span>
      </button>)}
    </div>
    <div className="brand-filter-row">
      <label className="brand-search">
        <span className="sr-only">ค้นหาโดเมน</span>
        <Search size={16} aria-hidden="true" />
        <input type="search" value={search} placeholder="ค้นหาชื่อหรือโดเมน" onChange={(e) => onSearch(e.target.value)} />
      </label>
      <label className="brand-sort">เรียงลำดับ
        <select value={sort} onChange={(e) => onSort(e.target.value as BrandSortMode)}>
          {BRAND_SORTS.filter((option) => owner || !option.ownerOnly).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <label className="brand-demo-toggle"><input type="checkbox" checked={showDemo} onChange={(e) => onShowDemo(e.target.checked)} />แสดงแบรนด์ทดลอง</label>
    </div>
  </div>;
}
