import React from 'react'
import { Check } from 'lucide-react'
import { Card } from '../ui/Card'
import { SourceChip } from '../ui/SourceChip'
import { TemplateThumb } from '../templates/TemplateThumb'
import { templates } from '../../data/templates'

const colors = [['#F83808', '#111111'], ['#0E7A4F', '#173A2B'], ['#244D91', '#111111'], ['#805000', '#3A2410']]
export function TemplateStep({ selected, onSelect, palette, onPalette }: { selected: string; onSelect: (id: string) => void; palette: number; onPalette: (index: number) => void }) {
  return <div className="space-y-5">
    <Card title="เลือกเทมเพลต" source={<SourceChip>D1 · templates · อนุมัติแล้ว</SourceChip>}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {templates.filter((t) => t.status === 'approved').slice(0, 6).map((t) => {
          const active = selected === t.id
          return <button key={t.id} type="button" onClick={() => onSelect(t.id)} aria-pressed={active} className={`focus-ring flex min-h-[120px] items-start gap-3 rounded-xl border p-3 text-left ${active ? 'border-brand bg-brand-tint/40' : 'border-line hover:bg-canvas'}`}>
            <TemplateThumb color={t.color} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t.name}</span><span className="mt-1 block text-xs text-sub">v{t.version} · ใช้โดย {t.brands} แบรนด์</span></span>{active && <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white"><Check className="h-3 w-3" /></span>}
          </button>
        })}
      </div>
    </Card>
    <Card title="สีแบรนด์">
      <p className="text-sm text-sub">เลือกคู่สีที่ใช้กับปุ่มหลักและส่วนเน้นของ landing page</p>
      <div className="mt-4 flex flex-wrap gap-3">{colors.map(([primary, ink], i) => <button key={primary} type="button" aria-label={`เลือกคู่สี ${i + 1}`} aria-pressed={palette === i} onClick={() => onPalette(i)} className={`focus-ring flex h-12 items-center gap-1 rounded-xl border p-1.5 ${palette === i ? 'border-brand ring-2 ring-brand ring-offset-2' : 'border-line'}`}><span className="h-8 w-8 rounded-lg" style={{ background: primary }} /><span className="h-8 w-8 rounded-lg" style={{ background: ink }} /></button>)}</div>
    </Card>
  </div>
}
