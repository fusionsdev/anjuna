import React, { useMemo, useState } from 'react'
import { Plus, Search, Store } from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { SourceChip } from '../components/ui/SourceChip'
import { BrandTable } from '../components/brands/BrandTable'
import { BrandDetailPanel } from '../components/brands/BrandDetailPanel'
import { brands } from '../data/brands'
import { ScopeSubtitle } from '../components/ui/ScopeSubtitle'
import { isBrandInScope } from '../utils/brandScope'
import type { BrandScope, BrandState } from '../types/app'

type Filter = 'fix' | 'all' | BrandState

const filters: { id: Filter; label: string; count: number }[] = [
  { id: 'fix', label: 'ต้องแก้', count: 3 },
  { id: 'all', label: 'ทั้งหมด', count: 28 },
  { id: 'active', label: 'ใช้งาน', count: 20 },
  { id: 'incomplete', label: 'ยังไม่เสร็จ', count: 3 },
  { id: 'paused', label: 'หยุด', count: 2 }
]

interface BrandsProps {
  selectedId: string
  onSelect: (id: string) => void
  onCreate: () => void
  scope: BrandScope
  onEditScope: () => void
}

export function Brands({ selectedId, onSelect, onCreate, scope, onEditScope }: BrandsProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [showTest, setShowTest] = useState(false)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return brands.filter((b) => {
      if (!showTest && b.isTest) return false
      if (!isBrandInScope(b, scope)) return false
      if (filter !== 'all' && b.state !== filter) return false
      if (q && !b.name.toLowerCase().includes(q) && !b.domain.toLowerCase().includes(q)) return false
      return true
    })
  }, [filter, query, showTest, scope])

  const selected = brands.find((b) => b.id === selectedId) ?? brands[0]

  return (
    <div className="space-y-5">
      <PageHeader
        title="แบรนด์"
        icon={Store}
        subtitle={<ScopeSubtitle scope={scope} onEdit={onEditScope}>แบรนด์ landing page ทั้งหมด พร้อมสถานะการติดตั้งและผลจาก AdKit</ScopeSubtitle>}
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={onCreate}>
            สร้างแบรนด์ใหม่
          </Button>
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div role="group" aria-label="กรองแบรนด์" className="flex flex-wrap gap-2">
          {filters.map((f) => {
            const active = filter === f.id
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(f.id)}
                className={`focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-full border px-4 text-sm transition-colors ${
                  active ? 'border-brand-tint bg-brand-tint font-medium text-brand-ink' : 'border-line bg-white text-ink hover:bg-canvas'
                }`}
              >
                {f.label}
                <span className={`num text-xs ${active ? 'text-brand-ink' : f.id === 'fix' ? 'text-bad' : 'text-sub'}`}>{f.count}</span>
              </button>
            )
          })}
        </div>
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center lg:justify-end">
          <label className="relative block sm:w-64">
            <span className="sr-only">ค้นหาแบรนด์</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sub" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ค้นหาชื่อหรือโดเมน"
              className="focus-ring h-11 w-full rounded-xl border border-line bg-white pl-9 pr-3 text-sm placeholder:text-sub"
            />
          </label>
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} className="focus-ring h-4 w-4 rounded accent-[#F83808]" />
            แสดงแบรนด์ทดลอง
          </label>
        </div>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card
          title={`${visible.length} แบรนด์`}
          source={<SourceChip>D1 · brands + AdKit · อัปเดต 14 นาทีที่แล้ว</SourceChip>}
          bodyClassName=""
        >
          {visible.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm font-medium">ไม่พบแบรนด์ที่ตรงกับตัวกรอง</p>
              <p className="mt-1 text-sm text-sub">ลองเปลี่ยนตัวกรองหรือคำค้นหา</p>
              <Button
                size="sm"
                className="mt-4"
                onClick={() => {
                  setFilter('all')
                  setQuery('')
                }}
              >
                ล้างตัวกรอง
              </Button>
            </div>
          ) : (
            <BrandTable brands={visible} selectedId={selected.id} onSelect={onSelect} onAction={(b) => onSelect(b.id)} showMenu compact />
          )}
        </Card>
        <BrandDetailPanel brand={selected} />
      </div>
    </div>
  )
}
