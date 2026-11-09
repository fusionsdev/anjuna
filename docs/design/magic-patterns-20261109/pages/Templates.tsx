import React, { useMemo, useState } from 'react'
import { CheckCircle2, Info, LayoutTemplate, Upload } from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { SourceChip } from '../components/ui/SourceChip'
import { CategoryList } from '../components/templates/CategoryList'
import { TemplateTable } from '../components/templates/TemplateTable'
import { BulkBar } from '../components/templates/BulkBar'
import { statusFilters, templates as seed } from '../data/templates'
import { ScopeSubtitle } from '../components/ui/ScopeSubtitle'
import type { BrandScope, Template, TemplateStatus } from '../types/app'

type StatusFilter = 'all' | TemplateStatus

export function Templates({ scope, onEditScope }: { scope: BrandScope; onEditScope: () => void }) {
  const [items, setItems] = useState<Template[]>(seed)
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)

  const visible = useMemo(
    () =>
      items.filter((t) => {
        if (category === 'all' ? t.category === 'archived' : t.category !== category) return false
        if (status !== 'all' && t.status !== status) return false
        return true
      }),
    [items, category, status]
  )

  const selectedItems = items.filter((t) => selected.has(t.id))
  const canDelete = selectedItems.every((t) => t.brands === 0)

  const flash = (msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice(null), 2600)
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const toggleAll = () => {
    const all = visible.every((t) => selected.has(t.id))
    setSelected(all ? new Set() : new Set(visible.map((t) => t.id)))
  }

  const moveSelected = (cat: string) => {
    setItems((prev) => prev.map((t) => (selected.has(t.id) ? { ...t, category: cat } : t)))
    flash(`ย้าย ${selected.size} รายการแล้ว`)
    setSelected(new Set())
  }

  const deleteSelected = () => {
    if (!canDelete) return
    setItems((prev) => prev.filter((t) => !selected.has(t.id)))
    flash(`ลบ ${selected.size} รายการถาวรแล้ว`)
    setSelected(new Set())
  }

  const statusChip = (id: StatusFilter, label: string, count?: number) => {
    const active = status === id
    return (
      <button
        key={id}
        type="button"
        aria-pressed={active}
        onClick={() => setStatus(id)}
        className={`focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-full border px-4 text-sm ${
          active ? 'border-brand-tint bg-brand-tint font-medium text-brand-ink' : 'border-line bg-white hover:bg-canvas'
        }`}
      >
        {label}
        {count != null && <span className={`num text-xs ${active ? 'text-brand-ink' : id === 'pending' ? 'text-warn' : 'text-sub'}`}>{count}</span>}
      </button>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="เทมเพลต"
        icon={LayoutTemplate}
        subtitle={<ScopeSubtitle scope={scope} onEdit={onEditScope}>เทมเพลต landing page ที่แบรนด์เลือกใช้ได้ ต้องอนุมัติก่อนใช้งานจริง</ScopeSubtitle>}
        actions={
          <Button variant="primary" icon={<Upload className="h-4 w-4" />}>
            อัปโหลดเทมเพลต
          </Button>
        }
      />

      <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <CategoryList
          active={category}
          onChange={(id) => {
            setCategory(id)
            setSelected(new Set())
          }}
        />

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {statusChip('all', 'ทุกสถานะ')}
            {statusFilters.map((s) => statusChip(s.id, s.label, s.count))}
            <span className="ml-auto">
              <SourceChip>D1 · templates · อัปเดต 3 นาทีที่แล้ว</SourceChip>
            </span>
          </div>

          {notice && (
            <div role="status" className="flex items-center gap-2 rounded-xl bg-ok-bg px-4 py-2.5 text-sm text-ok">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {notice}
            </div>
          )}

          <section className="overflow-hidden rounded-card border border-line bg-white">
            {selected.size > 0 && (
              <BulkBar
                count={selected.size}
                canDelete={canDelete}
                onMove={moveSelected}
                onArchive={() => moveSelected('archived')}
                onDelete={deleteSelected}
                onClear={() => setSelected(new Set())}
              />
            )}
            {visible.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <p className="text-sm font-medium">ไม่มีเทมเพลตในมุมมองนี้</p>
                <p className="mt-1 text-sm text-sub">ลองเลือกหมวดหรือสถานะอื่น</p>
              </div>
            ) : (
              <TemplateTable
                items={visible}
                selected={selected}
                onToggle={toggle}
                onToggleAll={toggleAll}
                onCategory={(id, cat) => setItems((prev) => prev.map((t) => (t.id === id ? { ...t, category: cat } : t)))}
                onAction={(t) => {
                  if (t.status === 'pending') {
                    setItems((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: 'approved' } : x)))
                    flash(`อนุมัติ ${t.name} แล้ว`)
                  }
                }}
              />
            )}
          </section>

          <footer className="flex items-start gap-3 rounded-card border border-line bg-white px-5 py-4 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
            <div className="space-y-1 text-sub">
              <p>
                <span className="font-medium text-ink">ลบถาวร</span> ได้เฉพาะเทมเพลตที่ไม่มีแบรนด์ใช้อยู่ (แบรนด์ที่ใช้ = <span className="num">0</span>)
              </p>
              <p>
                ถ้ามีแบรนด์ใช้อยู่ ให้ <span className="font-medium text-ink">เก็บถาวร</span> แทน — แบรนด์เดิมยังทำงานต่อได้ แต่แบรนด์ใหม่จะเลือกเทมเพลตนี้ไม่ได้
              </p>
            </div>
          </footer>
        </div>
      </div>
    </div>
  )
}
