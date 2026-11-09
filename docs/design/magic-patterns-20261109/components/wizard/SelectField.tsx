import React from 'react'
import { ChevronDown } from 'lucide-react'

interface SelectFieldProps {
  id: string
  label: string
  hint?: React.ReactNode
  value: string
  onChange: (v: string) => void
  options: { id: string; label: string }[]
}

export function SelectField({ id, label, hint, value, onChange, options }: SelectFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative mt-1.5">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="focus-ring h-11 w-full appearance-none rounded-xl border border-line bg-white pl-3 pr-9 text-sm"
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sub" aria-hidden="true" />
      </div>
      {hint && <p className="mt-1.5 text-xs text-sub">{hint}</p>}
    </div>
  )
}
