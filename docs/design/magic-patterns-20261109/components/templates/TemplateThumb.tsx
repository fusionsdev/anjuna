import React from 'react'

export function TemplateThumb({ color }: { color: string }) {
  return (
    <div className="flex h-12 w-16 shrink-0 flex-col gap-1 overflow-hidden rounded-lg border border-line bg-canvas p-1.5" aria-hidden="true">
      <div className="h-1 w-6 rounded-full bg-[#C9C9C4]" />
      <div className="h-1.5 w-10 rounded-full bg-ink/70" />
      <div className="h-1 w-8 rounded-full bg-[#C9C9C4]" />
      <div className="mt-auto h-2 w-7 rounded" style={{ backgroundColor: color }} />
    </div>
  )
}
