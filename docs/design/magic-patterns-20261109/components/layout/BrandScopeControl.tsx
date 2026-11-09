import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react'
import { brands } from '../../data/brands'
import { isBrandInScope } from '../../utils/brandScope'
import type { BrandScope, BrandState } from '../../types/app'

interface BrandScopeControlProps { scope: BrandScope; onApply: (scope: BrandScope) => void; compact?: boolean; open?: boolean; onOpenChange?: (value: boolean) => void }
const groups: { state: BrandState | 'test'; label: string }[] = [
  { state: 'active', label: 'ใช้งาน' }, { state: 'fix', label: 'ต้องแก้' }, { state: 'incomplete', label: 'ยังไม่เสร็จ' }, { state: 'paused', label: 'หยุด' }, { state: 'retired', label: 'เลิกใช้แล้ว' }, { state: 'test', label: 'ทดลอง' }
]

export function BrandScopeControl({ scope, onApply, compact = false, open: controlledOpen, onOpenChange }: BrandScopeControlProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setOpen = (value: boolean | ((current: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(open) : value
    if (controlledOpen === undefined) setLocalOpen(next)
    onOpenChange?.(next)
  }
  const [draft, setDraft] = useState(scope)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { setDraft(scope) }, [scope, open])
  useEffect(() => { if (!open) return; const close = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false) }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close) }, [open])
  const visibleCount = brands.filter((brand) => isBrandInScope(brand, scope)).length
  const listed = useMemo(() => brands.filter((brand) => !query || `${brand.name} ${brand.domain}`.toLowerCase().includes(query.toLowerCase())), [query])
  const toggleId = (id: string) => setDraft((current) => ({ ...current, selectedIds: current.selectedIds.includes(id) ? current.selectedIds.filter((item) => item !== id) : [...current.selectedIds, id] }))
  const groupItems = (state: BrandState | 'test') => listed.filter((brand) => state === 'test' ? !!brand.isTest : !brand.isTest && brand.state === state)
  const selectGroup = (items: typeof brands) => setDraft((current) => ({ ...current, selectedIds: Array.from(new Set([...current.selectedIds, ...items.map((item) => item.id)])) }))
  const clear = () => setDraft((current) => ({ ...current, selectedIds: [] }))
  return <div className="relative" ref={ref}>
    <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="dialog" className={`focus-ring flex min-h-[44px] items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-medium hover:bg-canvas ${compact ? 'max-w-[190px]' : 'w-full justify-between'}`}>
      <SlidersHorizontal className="h-4 w-4 shrink-0 text-sub" aria-hidden="true"/><span className="truncate">แบรนด์ที่ใช้งาน · <span className="num">{visibleCount}</span></span><ChevronDown className="h-4 w-4 shrink-0 text-sub"/>
    </button>
    {open && <div role="dialog" aria-label="ขอบเขตแบรนด์" className={`absolute z-50 mt-2 rounded-xl border border-line bg-white p-4 shadow-[0_8px_24px_rgba(17,17,17,0.12)] ${compact ? 'right-0 w-[min(360px,calc(100vw-16px))]' : 'left-0 w-[360px]'}`}>
      <div className="flex items-center justify-between"><h2 className="text-base font-semibold">ขอบเขตแบรนด์</h2><button type="button" onClick={() => setOpen(false)} className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl hover:bg-canvas" aria-label="ปิด"><X className="h-4 w-4"/></button></div>
      <Toggle checked={draft.hideUnused} onChange={() => setDraft((current) => ({ ...current, hideUnused: !current.hideUnused }))} label="ซ่อนแบรนด์ที่ไม่ได้ใช้แล้ว"/>
      <Toggle checked={draft.showTest} onChange={() => setDraft((current) => ({ ...current, showTest: !current.showTest }))} label="แสดงแบรนด์ทดลอง"/>
      <label className="relative mt-3 block"><span className="sr-only">ค้นหาแบรนด์</span><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sub"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาชื่อหรือโดเมน" className="focus-ring h-11 w-full rounded-xl border border-line bg-white pl-9 pr-3 text-sm placeholder:text-sub"/></label>
      <div className="mt-3 max-h-72 overflow-y-auto border-y border-line py-2">{groups.map((group) => { const items = groupItems(group.state); if (!items.length) return null; return <section key={group.state} className="py-2"><div className="flex items-center justify-between"><h3 className="text-xs font-medium text-sub">{group.label}</h3><button type="button" onClick={() => selectGroup(items)} className="focus-ring min-h-[44px] rounded-lg px-2 text-xs font-medium text-brand-ink">เลือกทั้งหมด</button></div>{items.map((brand) => <label key={brand.id} className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={draft.selectedIds.includes(brand.id)} onChange={() => toggleId(brand.id)} className="focus-ring h-4 w-4 accent-[#F83808]"/><span className="min-w-0 flex-1 truncate">{brand.name}</span><span className="truncate text-xs text-sub">{brand.domain}</span></label>)}</section> })}</div>
      <div className="mt-3 flex justify-between gap-2"><button type="button" onClick={clear} className="focus-ring min-h-[44px] rounded-xl px-3 text-sm font-medium text-sub hover:bg-canvas">ล้าง</button><button type="button" onClick={() => { onApply(draft); setOpen(false) }} className="focus-ring min-h-[44px] rounded-xl bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover">ใช้</button></div>
    </div>}
  </div>
}
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) { return <button type="button" role="switch" aria-checked={checked} onClick={onChange} className="focus-ring mt-3 flex min-h-[44px] w-full items-center justify-between rounded-xl bg-canvas px-3 text-left text-sm"><span>{label}</span><span className={`relative flex h-6 w-11 items-center rounded-full p-1 ${checked ? 'bg-brand' : 'bg-[#B9B9B5]'}`}><span className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`}/></span></button> }
