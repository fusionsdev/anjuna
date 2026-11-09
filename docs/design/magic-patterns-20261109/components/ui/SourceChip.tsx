import React from 'react'
import { Database } from 'lucide-react'
export function SourceChip({ children }: { children: React.ReactNode }) { return <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line bg-canvas px-2.5 py-1 text-[13px] font-medium leading-none text-sub"><Database className="h-3.5 w-3.5" aria-hidden="true"/>{children}</span> }
