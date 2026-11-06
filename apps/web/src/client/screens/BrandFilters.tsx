import { BRAND_CHIPS, BRAND_SORTS, type BrandChip, type BrandSortMode } from "../brand-health";
import { FilterBar } from "../components/FilterBar";

// spec brands (FUS-377). Local to the Brands screen on purpose: a shared FilterBar would collide with lane B.
// showDemo: the "แสดงแบรนด์ทดลอง" box. Brands named demo<digits> stay out of the list until it is on.
export function BrandFilters({ chip, onChip, counts, sort, onSort, owner, search, onSearch, showDemo, onShowDemo }: {
  chip: BrandChip; onChip: (chip: BrandChip) => void; counts: Record<BrandChip, number>;
  sort: BrandSortMode; onSort: (mode: BrandSortMode) => void; owner: boolean;
  search: string; onSearch: (value: string) => void;
  showDemo: boolean; onShowDemo: (value: boolean) => void;
}) {
  return <div className="brand-filters">
    <div className="brand-chip-row">
      <div className="brand-chips" role="group" aria-label="ตัวกรองแบรนด์">
        {BRAND_CHIPS.map(({ id, label }) => <button key={id} type="button" className="brand-chip" aria-pressed={chip === id} onClick={() => onChip(id)}>
          {label} <span className="brand-chip-count">{counts[id]}</span>
        </button>)}
      </div>
      {/* Beside the chips, outside the modal, so a narrow screen keeps it in reach. */}
      <label className="brand-demo-toggle"><input type="checkbox" checked={showDemo} onChange={(e) => onShowDemo(e.target.checked)} />แสดงแบรนด์ทดลอง</label>
    </div>
    {/* The chips stay outside the modal like segment buttons, so only sort and search count. */}
    <FilterBar label="ตัวกรองแบรนด์" activeCount={(sort !== "issues" ? 1 : 0) + (search ? 1 : 0)}>
    <div className="brand-filter-fields">
      <label>เรียงลำดับ
        <select value={sort} onChange={(e) => onSort(e.target.value as BrandSortMode)}>
          {BRAND_SORTS.filter((option) => owner || !option.ownerOnly).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <label>ค้นหาโดเมน
        <input type="search" value={search} onChange={(e) => onSearch(e.target.value)} />
      </label>
    </div>
    </FilterBar>
  </div>;
}
