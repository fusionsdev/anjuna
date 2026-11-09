import React, { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'

const items = [
  { label: 'เปิดเว็บไซต์', danger: false },
  { label: 'แก้ไขแบรนด์', danger: false },
  { label: 'ดูลีดทั้งหมด', danger: false },
  { label: 'หยุดแบรนด์', danger: true }
]

export function RowMenu({ brandName }: { brandName: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`ตัวเลือกเพิ่มเติมของ ${brandName}`}
        className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-white text-sub hover:bg-canvas"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-20 w-44 rounded-xl border border-line bg-white p-1 shadow-[0_8px_24px_rgba(17,17,17,0.08)]">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
              }}
              className={`focus-ring flex min-h-[44px] w-full items-center rounded-lg px-3 text-left text-sm hover:bg-canvas ${it.danger ? 'text-bad' : 'text-ink'}`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
