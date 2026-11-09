import React from 'react'
import { Menu } from 'lucide-react'
import { BrandScopeControl } from './BrandScopeControl'
import type { BrandScope } from '../../types/app'

export function MobileTopBar({ onOpen, scope, onScopeApply, scopeOpen, onScopeOpenChange }: { onOpen: () => void; scope: BrandScope; onScopeApply: (scope: BrandScope) => void; scopeOpen: boolean; onScopeOpenChange: (open: boolean) => void }) {
  return <div className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-white px-2 lg:hidden"><button type="button" onClick={onOpen} className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl hover:bg-canvas" aria-label="เปิดเมนู"><Menu className="h-5 w-5" aria-hidden="true"/></button><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand text-xs font-bold text-white">A</span><span className="min-w-0 flex-1 truncate font-semibold">Anjuna</span><BrandScopeControl compact scope={scope} onApply={onScopeApply} open={scopeOpen} onOpenChange={onScopeOpenChange}/></div>
}
