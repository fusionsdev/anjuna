import React from 'react'
import { Archive, Folder, Plus } from 'lucide-react'
import { categories } from '../../data/templates'

interface CategoryListProps {
  active: string
  onChange: (id: string) => void
}

export function CategoryList({ active, onChange }: CategoryListProps) {
  return (
    <nav aria-label="หมวดเทมเพลต" className="rounded-card border border-line bg-white p-2">
      <ul className="flex gap-1 overflow-x-auto lg:flex-col">
        {categories.map((c) => {
          const isActive = c.id === active
          const Icon = c.id === 'archived' ? Archive : Folder
          return (
            <li key={c.id} className={c.id === 'archived' ? 'lg:mt-1 lg:border-t lg:border-line lg:pt-1' : ''}>
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => onChange(c.id)}
                className={`focus-ring flex min-h-[44px] w-full shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 text-left text-sm ${
                  isActive ? 'bg-brand-tint font-medium text-brand-ink' : 'text-ink hover:bg-canvas'
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? 'text-brand-ink' : 'text-sub'}`} aria-hidden="true" />
                <span className="flex-1">{c.label}</span>
                <span className={`num text-xs ${isActive ? 'text-brand-ink' : 'text-sub'}`}>{c.count}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        className="focus-ring mt-1 hidden min-h-[44px] w-full items-center gap-2 rounded-xl border border-dashed border-line px-3 text-sm text-sub hover:bg-canvas hover:text-ink lg:flex"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        เพิ่มหมวด
      </button>
    </nav>
  )
}
