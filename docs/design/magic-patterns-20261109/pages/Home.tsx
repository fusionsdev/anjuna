import React, { useState } from 'react'
import { Home as HomeIcon, Plus } from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { SourceChip } from '../components/ui/SourceChip'
import { IncidentBanner } from '../components/home/IncidentBanner'
import { FixListCard } from '../components/home/FixListCard'
import { HumanTasksCard } from '../components/home/HumanTasksCard'
import { KpiRow } from '../components/home/KpiRow'
import { FunnelStrip } from '../components/home/FunnelStrip'
import { ConversionQueueCard } from '../components/home/ConversionQueueCard'
import { BrandTable } from '../components/brands/BrandTable'
import { brands, homeBrandIds } from '../data/brands'
import { ScopeSubtitle } from '../components/ui/ScopeSubtitle'
import { isBrandInScope } from '../utils/brandScope'
import type { BrandScope, PageId } from '../types/app'

type Range = 'today' | '7d' | '30d'

const ranges: { id: Range; label: string; compare: string }[] = [
  { id: 'today', label: 'วันนี้', compare: 'เทียบกับเมื่อวาน' },
  { id: '7d', label: '7 วัน', compare: 'เทียบกับ 7 วันก่อนหน้า' },
  { id: '30d', label: '30 วัน', compare: 'เทียบกับ 30 วันก่อนหน้า' }
]

interface HomeProps { onNavigate: (p: PageId) => void; onOpenBrand: (id: string) => void; scope: BrandScope; onEditScope: () => void }

export function Home({ onNavigate, onOpenBrand, scope, onEditScope }: HomeProps) {
  const [range, setRange] = useState<Range>('today')
  const current = ranges.find((r) => r.id === range) ?? ranges[0]
  const homeBrands = homeBrandIds.map((id) => brands.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b).filter((brand) => isBrandInScope(brand, scope))

  return (
    <div className="space-y-5">
      <PageHeader
        title="หน้าแรก"
        icon={HomeIcon}
        subtitle={<ScopeSubtitle scope={scope} onEdit={onEditScope}>วันศุกร์ 6 พฤศจิกายน 2569</ScopeSubtitle>}
        actions={
          <>
            <div role="group" aria-label="ช่วงเวลา" className="flex rounded-xl border border-line bg-white p-1">
              {ranges.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={range === r.id}
                  onClick={() => setRange(r.id)}
                  className={`focus-ring min-h-[44px] rounded-lg px-3 text-sm transition-colors ${
                    range === r.id ? 'bg-ink font-medium text-white' : 'text-sub hover:text-ink'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <span className="text-sm text-sub">{current.compare}</span>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => onNavigate('new-brand')}>
              สร้างแบรนด์ใหม่
            </Button>
          </>
        }
      />

      <IncidentBanner onQueue={() => onNavigate('leads')} onAlerts={() => onNavigate('alerts')} />

      <div className="grid gap-5 lg:grid-cols-2">
        <FixListCard onOpenBrand={onOpenBrand} />
        <HumanTasksCard onNavigate={onNavigate} />
      </div>

      <KpiRow compareLabel={current.compare} brands={homeBrands} />

      <Card
        title="แบรนด์"
        source={<SourceChip>D1 · brands + AdKit · อัปเดต 14 นาทีที่แล้ว</SourceChip>}
        action={
          <Button size="sm" variant="ghost" onClick={() => onNavigate('brands')}>
            ดูทั้งหมด 28
          </Button>
        }
        bodyClassName=""
      >
        <BrandTable brands={homeBrands} onAction={(b) => onOpenBrand(b.id)} />
      </Card>

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <FunnelStrip />
        <ConversionQueueCard onOpen={() => onNavigate('leads')} />
      </div>
    </div>
  )
}
