import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Card } from '../ui/Card'
import { Chip } from '../ui/Chip'
import { Button } from '../ui/Button'
import { SourceChip } from '../ui/SourceChip'
import { fixItems } from '../../data/home'

export function FixListCard({ onOpenBrand }: { onOpenBrand: (id: string) => void }) {
  const [retrying, setRetrying] = useState<string | null>(null)

  const handle = (id: string, brandId: string, action: string) => {
    if (action === 'ลองใหม่') {
      setRetrying(id)
      window.setTimeout(() => setRetrying(null), 1600)
      return
    }
    onOpenBrand(brandId)
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          ต้องแก้ <Chip tone="danger">{fixItems.length}</Chip>
        </span>
      }
      source={<SourceChip>D1 · health checks</SourceChip>}
      bodyClassName=""
    >
      <ul className="divide-y divide-line">
        {fixItems.map((f) => (
          <li key={f.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center">
            <span className={`hidden h-2 w-2 shrink-0 rounded-full sm:block ${f.tone === 'danger' ? 'bg-bad' : 'bg-[#E0A030]'}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-semibold">{f.brand}</span>
                <span className="text-sub"> · </span>
                <span className={f.tone === 'danger' ? 'text-bad' : 'text-warn'}>{f.issue}</span>
              </p>
              <p className="mt-0.5 text-xs text-sub">{f.detail}</p>
            </div>
            <Button
              size="sm"
              variant={f.primary ? 'primary' : 'secondary'}
              onClick={() => handle(f.id, f.brandId, f.action)}
              disabled={retrying === f.id}
              icon={retrying === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
            >
              {retrying === f.id ? 'กำลังลอง…' : f.action}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
