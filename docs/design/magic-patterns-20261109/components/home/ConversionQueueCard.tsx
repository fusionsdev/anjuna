import React from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { SourceChip } from '../ui/SourceChip'
import { queueStats } from '../../data/home'
import { num } from '../../utils/format'
import type { Tone } from '../../types/app'

const valueTone: Record<Tone, string> = {
  success: 'text-ok',
  danger: 'text-bad',
  warning: 'text-warn',
  info: 'text-info',
  neutral: 'text-ink',
  accent: 'text-brand-ink'
}

export function ConversionQueueCard({ onOpen }: { onOpen: () => void }) {
  return (
    <Card
      title="คิวคอนเวอร์ชัน"
      source={<SourceChip>AdKit ผ่าน drain · อัปเดต 14 นาทีที่แล้ว</SourceChip>}
      action={
        <Button size="sm" variant="ghost" onClick={onOpen}>
          ดูคิว
        </Button>
      }
    >
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {queueStats.map((q) => (
          <div key={q.label} className="rounded-xl bg-canvas p-3">
            <dt className="text-[13px] font-medium text-sub">{q.label}</dt>
            <dd className={`num mt-1 text-[28px] font-semibold leading-none ${q.value ? valueTone[q.tone] : 'text-ink'}`}>{num(q.value)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 flex items-start gap-1.5 text-[13px] text-sub">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden="true" />
        <span>
          กระทบยอด: ขายได้ <span className="num">19</span> = ส่งแล้ว <span className="num">15</span> + ส่งไม่ได้ <span className="num">4</span> + ค้างส่ง{' '}
          <span className="num">0</span> · ตรงกับ LeadsGate
        </span>
      </p>
    </Card>
  )
}
