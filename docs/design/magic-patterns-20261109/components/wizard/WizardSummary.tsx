import React from 'react'
import { Check } from 'lucide-react'
import { Card } from '../ui/Card'
import { apiEndpoints } from '../../data/wizard'

interface WizardSummaryProps {
  items: { label: string; value: string; done: boolean }[]
}

export function WizardSummary({ items }: WizardSummaryProps) {
  return (
    <div className="space-y-6 lg:sticky lg:top-6">
      <Card title="สรุป">
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.label} className="flex items-start gap-3">
              {it.done ? (
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok text-white" aria-label="เสร็จแล้ว">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
              ) : (
                <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-dashed border-[#C9C9C4]" aria-label="ยังไม่เสร็จ" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">{it.label}</p>
                <p className="truncate text-[13px] text-sub">{it.value}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <div className="rounded-card border border-line bg-white p-4">
        <p className="text-[13px] font-medium text-sub">สร้างผ่าน API</p>
        <ul className="mt-2 space-y-1 rounded-xl bg-canvas p-3 font-mono text-[13px] leading-relaxed text-ink">
          {apiEndpoints.map((e) => (
            <li key={e} className="break-all">
              <span className="text-brand-ink">{e.split(' ')[0]}</span> {e.split(' ')[1]}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
