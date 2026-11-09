import React, { useState } from 'react'
import { CheckCircle2, RefreshCw } from 'lucide-react'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { SourceChip } from '../ui/SourceChip'
export function DomainStep({ domain }: { domain: string }) {
  const [checked, setChecked] = useState(false)
  return <Card title="ตรวจ zone ของโดเมน" source={<SourceChip>DNS health check · ตรวจล่าสุดเมื่อครู่</SourceChip>}>
    <div className={`rounded-xl border p-4 ${checked ? 'border-[#BFE3D1] bg-ok-bg' : 'border-[#F2D49A] bg-warn-bg'}`}>
      <div className="flex items-start gap-3"><CheckCircle2 className={`mt-0.5 h-5 w-5 ${checked ? 'text-ok' : 'text-warn'}`} /><div><p className="text-base font-semibold">{checked ? 'พร้อมเชื่อมต่อ' : 'รอ DNS'}</p><p className="mt-1 text-sm text-sub">{checked ? `${domain || 'โดเมนนี้'} ชี้ A record มาที่ Anjuna แล้ว` : `ยังไม่พบ A record ของ ${domain || 'โดเมนนี้'} — เพิ่ม A record แล้วตรวจอีกครั้ง`}</p></div></div>
    </div>
    <dl className="mt-4 grid gap-2 sm:grid-cols-2"><div className="rounded-xl bg-canvas p-3"><dt className="text-xs text-sub">A record</dt><dd className="num mt-1 text-sm font-semibold">185.199.108.153</dd></div><div className="rounded-xl bg-canvas p-3"><dt className="text-xs text-sub">SSL</dt><dd className="mt-1 text-sm font-semibold">รอ DNS</dd></div></dl>
    <Button className="mt-4" onClick={() => setChecked(true)} icon={<RefreshCw className="h-4 w-4" />}>ตรวจอีกครั้ง</Button>
  </Card>
}
