import React from 'react'
import { stageLabels } from '../../data/brands'
import type { StageStatus } from '../../types/app'

const dotClass: Record<StageStatus, string> = {
  done: 'bg-ok',
  warn: 'bg-[#E0A030]',
  fail: 'bg-bad',
  pending: 'bg-white border border-[#C9C9C4]'
}

const statusText: Record<StageStatus, string> = {
  done: 'เสร็จ',
  warn: 'มีปัญหา',
  fail: 'ล้มเหลว',
  pending: 'ยังไม่เริ่ม'
}

export function StageDots({ stages }: { stages: StageStatus[] }) {
  const label = stages.map((s, i) => `${stageLabels[i]}: ${statusText[s]}`).join(', ')
  return (
    <div className="flex items-center gap-1" role="img" aria-label={label}>
      {stages.map((s, i) => (
        <span key={stageLabels[i]} title={`${stageLabels[i]} · ${statusText[s]}`} className={`h-2.5 w-2.5 rounded-full ${dotClass[s]}`} />
      ))}
    </div>
  )
}
