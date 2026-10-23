import { BRAND_CHIPS, BRAND_SORTS, type BrandChip, type BrandSortMode } from "../brand-health";

// spec brands (FUS-377). Local to the Brands screen on purpose: a shared FilterBar would collide with lane B.
export function BrandFilters({ chip, onChip, counts, sort, onSort, owner, search, onSearch }: {
  chip: BrandChip; onChip: (chip: BrandChip) => void; counts: Record<BrandChip, number>;
  sort: BrandSortMode; onSort: (mode: BrandSortMode) => void; owner: boolean;
  search: string; onSearch: (value: string) => void;
}) {
  return <div className="brand-filters">
    <div className="brand-chips" role="group" aria-label="ตัวกรองแบรนด์ (Brand filters)">
      {BRAND_CHIPS.map(({ id, label }) => <button key={id} type="button" className="brand-chip" aria-pressed={chip === id} onClick={() => onChip(id)}>
        {label} <span className="brand-chip-count">{counts[id]}</span>
      </button>)}
    </div>
    <div className="brand-filter-fields">
      <label>เรียงลำดับ (Sort)
        <select value={sort} onChange={(e) => onSort(e.target.value as BrandSortMode)}>
          {BRAND_SORTS.filter((option) => owner || !option.ownerOnly).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <label>ค้นหาโดเมน (Search domain)
        <input type="search" value={search} onChange={(e) => onSearch(e.target.value)} />
      </label>
    </div>
  </div>;
}
