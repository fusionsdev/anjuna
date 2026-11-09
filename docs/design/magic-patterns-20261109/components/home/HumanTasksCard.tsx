import React from 'react'
import { ChevronRight } from 'lucide-react'
import { Card } from '../ui/Card'
import { SourceChip } from '../ui/SourceChip'
import { humanTasks } from '../../data/home'
import type { PageId } from '../../types/app'

export function HumanTasksCard({ onNavigate }: { onNavigate: (p: PageId) => void }) {
  return (
    <Card title="งานที่ต้องใช้คน" source={<SourceChip>D1 · tasks</SourceChip>} bodyClassName="">
      <ul className="divide-y divide-line">
        {humanTasks.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onNavigate(t.page)}
              className="focus-ring group flex min-h-[56px] w-full items-center gap-4 px-5 py-3 text-left hover:bg-canvas/60"
            >
              <span className="num w-10 text-xl font-semibold text-ink">{t.count}</span>
              <span className="flex-1">
                <span className="block text-sm font-medium">{t.label}</span>
                <span className="block text-xs text-sub">
                  <span className="num">{t.count}</span> {t.unit}
                </span>
              </span>
              <span className="inline-flex items-center gap-0.5 text-sm font-medium text-brand-ink">
                {t.action}
                <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
