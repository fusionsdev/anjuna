import React from 'react'
import { Check, LayoutTemplate, Rocket, Store, Target, Type } from 'lucide-react'
import { wizardSteps } from '../../data/wizard'
import { Icon } from '../ui/Icon'

const stepIcons = [Store, LayoutTemplate, Type, Target, Rocket]

export function WizardStepper({ current, onStepClick }: { current: number; onStepClick?: (step: number) => void }) {
  return <ol className="flex gap-2 overflow-x-auto pb-1" aria-label="ขั้นตอนการสร้างแบรนด์">{wizardSteps.map((label, index) => { const step = index + 1; const done = step < current; const active = step === current; const StepIcon = stepIcons[index]; const content = <><span className={`num flex h-5 w-5 items-center justify-center rounded-full text-xs font-semibold ${active ? 'bg-brand text-white' : done ? 'bg-ok text-white' : 'border border-line bg-white text-sub'}`}>{done ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true"/> : active ? step : <Icon icon={StepIcon} tone="sub" className="h-3.5 w-3.5"/>}</span>{label}</>; return <li key={label}>{done && onStepClick ? <button type="button" onClick={() => onStepClick(step)} className="focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-full border border-line bg-white px-3.5 text-sm text-ink hover:bg-canvas">{content}</button> : <span aria-current={active ? 'step' : undefined} className={`inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm ${active ? 'border-brand bg-brand-tint font-medium text-brand-ink' : done ? 'border-line bg-white text-ink' : 'border-line bg-canvas text-sub'}`}>{content}</span>}</li> })}</ol>
}
