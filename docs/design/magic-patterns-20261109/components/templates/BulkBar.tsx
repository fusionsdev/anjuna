import React from 'react'
import { Archive, Trash2, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { categories } from '../../data/templates'

interface BulkBarProps {
  count: number
  canDelete: boolean
  onMove: (category: string) => void
  onArchive: () => void
  onDelete: () => void
  onClear: () => void
}

export function BulkBar({ count, canDelete, onMove, onArchive, onDelete, onClear }: BulkBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-ink px-4 py-2 text-white">
      <span className="num mr-2 text-sm font-medium">เลือก {count} รายการ</span>
      <label className="sr-only" htmlFor="bulk-move">
        ย้ายไปหมวด
      </label>
      <select
        id="bulk-move"
        value=""
        onChange={(e) => e.target.value && onMove(e.target.value)}
        className="focus-ring h-11 rounded-xl border border-white/20 bg-white/10 px-3 text-sm text-white"
      >
        <option value="" className="text-ink">
          ย้ายไปหมวด…
        </option>
        {categories
          .filter((c) => c.id !== 'all' && c.id !== 'archived')
          .map((c) => (
            <option key={c.id} value={c.id} className="text-ink">
              {c.label}
            </option>
          ))}
      </select>
      <Button size="sm" variant="ghost" className="text-white hover:bg-white/10" icon={<Archive className="h-4 w-4" />} onClick={onArchive}>
        เก็บถาวร
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-white hover:bg-white/10"
        icon={<Trash2 className="h-4 w-4" />}
        onClick={onDelete}
        disabled={!canDelete}
        title={canDelete ? undefined : 'มีเทมเพลตที่แบรนด์ใช้อยู่ — ใช้เก็บถาวรแทน'}
      >
        ลบ
      </Button>
      {!canDelete && <span className="text-xs text-white/70">มีเทมเพลตที่แบรนด์ใช้อยู่ ลบไม่ได้</span>}
      <button type="button" onClick={onClear} className="focus-ring ml-auto flex h-11 w-11 items-center justify-center rounded-xl hover:bg-white/10" aria-label="ยกเลิกการเลือก">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
