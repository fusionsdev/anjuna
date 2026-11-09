import React from 'react'
import { BadgeCheck, DoorOpen, Eye, PencilLine, Users } from 'lucide-react'
import { Card } from '../ui/Card'
import { Icon } from '../ui/Icon'
import { SourceChip } from '../ui/SourceChip'
import { funnel } from '../../data/home'
const stageIcons = [Eye, DoorOpen, PencilLine, Users, BadgeCheck]
export function FunnelStrip() { const max = funnel[0].value; return <Card title="Funnel" source={<SourceChip>D1 · funnel</SourceChip>}><ol className="grid grid-cols-2 gap-4 sm:grid-cols-5">{funnel.map((f, i) => { const prev = i > 0 ? funnel[i - 1].value : null; const rate = prev ? Math.round(f.value / prev * 100) : null; const last = i === funnel.length - 1; return <li key={f.label} className="flex flex-col"><p className="flex items-center gap-1.5 text-[13px] font-medium text-sub"><Icon icon={stageIcons[i]}/>{f.label}</p><p className={`num mt-2 text-[28px] font-semibold leading-none ${last ? 'text-brand-ink' : ''}`}>{f.value}</p><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-canvas"><div className={`h-full rounded-full ${last ? 'bg-brand' : 'bg-ink'}`} style={{ width: `${f.value / max * 100}%` }}/></div><p className="num mt-2 text-[13px] text-sub">{rate == null ? '100%' : `→ ${rate}%`}</p></li> })}</ol></Card> }
