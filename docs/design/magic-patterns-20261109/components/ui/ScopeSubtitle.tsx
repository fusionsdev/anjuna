import React from 'react'
import { Chip } from './Chip'
import { scopeSummary } from '../../utils/brandScope'
import type { BrandScope } from '../../types/app'

export function ScopeSubtitle({ children, scope, onEdit }: { children: React.ReactNode; scope: BrandScope; onEdit: () => void }) {
  return <span className="inline-flex flex-wrap items-center gap-2">{children}<Chip tone="neutral">{scopeSummary(scope)}</Chip><button type="button" onClick={onEdit} className="focus-ring rounded px-1 text-sm font-medium text-brand-ink hover:underline">แก้ไข</button></span>
}
