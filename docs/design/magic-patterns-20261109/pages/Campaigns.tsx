import React, { useMemo, useState } from 'react'
import { ExternalLink, Megaphone, Plus, RotateCcw, Save } from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Chip } from '../components/ui/Chip'
import { SourceChip } from '../components/ui/SourceChip'
import { Button } from '../components/ui/Button'
import { campaigns, campaignStatus, type Campaign, type CampaignStatus } from '../data/operations'
import { ScopeSubtitle } from '../components/ui/ScopeSubtitle'
import { isDisplayBrandInScope } from '../utils/brandScope'
import type { BrandScope } from '../types/app'

const filters: { id: 'all' | CampaignStatus; label: string }[] = [
  { id: 'all', label: 'ทั้งหมด' }, { id: 'draft', label: 'ร่าง' }, { id: 'building', label: 'กำลังสร้าง' }, { id: 'active', label: 'เปิดใช้' }, { id: 'paused', label: 'หยุด' }, { id: 'failed', label: 'ล้มเหลว' }
]

export function Campaigns({ scope, onEditScope }: { scope: BrandScope; onEditScope: () => void }) {
  const [filter, setFilter] = useState<'all' | CampaignStatus>('all')
  const [selectedId, setSelectedId] = useState(campaigns[0].id)
  const [budget, setBudget] = useState(String(campaigns[0].budget))
  const [notice, setNotice] = useState('')
  const visible = useMemo(() => campaigns.filter((c) => isDisplayBrandInScope(c.brand, scope) && (filter === 'all' || c.status === filter)), [filter, scope])
  const selected = campaigns.find((c) => c.id === selectedId) ?? visible[0] ?? campaigns[0]
  const count = (id: 'all' | CampaignStatus) => (id === 'all' ? campaigns.length : campaigns.filter((c) => c.status === id).length)
  const choose = (campaign: Campaign) => { setSelectedId(campaign.id); setBudget(String(campaign.budget)) }
  const act = (campaign: Campaign) => { setNotice(`${campaign.name}: ส่งงาน ${campaign.status === 'failed' ? 'ลองใหม่' : campaign.status === 'draft' ? 'สร้างแคมเปญ' : 'เปิดใช้ใหม่'} แล้ว`) }

  return <div className="space-y-5">
    <PageHeader title="แคมเปญ" icon={Megaphone} subtitle={<ScopeSubtitle scope={scope} onEdit={onEditScope}>แคมเปญ Google Ads ที่สร้างจาก Anjuna ผ่าน AdKit</ScopeSubtitle>} actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />}>สร้างแคมเปญ</Button>} />
    <div className="flex flex-wrap gap-2" role="group" aria-label="กรองสถานะแคมเปญ">
      {filters.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} className={`focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-full border px-4 text-sm ${filter === f.id ? 'border-brand-tint bg-brand-tint font-medium text-brand-ink' : 'border-line bg-white hover:bg-canvas'}`}>
        {f.label}<span className="num text-xs">{count(f.id)}</span>
      </button>)}
    </div>
    {notice && <div role="status" className="rounded-xl bg-ok-bg px-4 py-3 text-sm font-medium text-ok">{notice}</div>}
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card title="แคมเปญทั้งหมด" source={<SourceChip>D1 · campaigns + AdKit jobs</SourceChip>} bodyClassName="p-0">
        <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[820px] border-collapse"><thead><tr className="border-b border-line">{['แบรนด์','ชื่อแคมเปญ','สถานะ','งบ/วัน','คีย์เวิร์ด','Final URL','งานล่าสุด',''].map((h) => <th key={h} className="px-4 py-3 text-left text-xs font-medium text-sub">{h}</th>)}</tr></thead><tbody>
          {visible.map((c) => <CampaignRow key={c.id} campaign={c} selected={c.id === selected.id} onSelect={() => choose(c)} onAction={() => act(c)} />)}
        </tbody></table></div>
        <ul className="divide-y divide-line md:hidden">{visible.map((c) => <li key={c.id} className={`space-y-3 p-4 ${c.id === selected.id ? 'bg-brand-tint/40' : ''}`}><button type="button" onClick={() => choose(c)} className="focus-ring w-full rounded-lg text-left"><p className="text-sm font-medium">{c.brand}</p><p className="text-sm text-sub">{c.name}</p></button><div className="flex flex-wrap items-center justify-between gap-2"><Chip tone={campaignStatus[c.status].tone} dot>{campaignStatus[c.status].label}</Chip><span className="num text-sm">฿{c.budget.toLocaleString()}/วัน</span></div><p className="truncate font-mono text-xs text-sub">{c.url}</p><CampaignAction campaign={c} onAction={() => act(c)} /></li>)}</ul>
      </Card>
      <CampaignDetail campaign={selected} budget={budget} setBudget={setBudget} onSaved={() => setNotice(`บันทึกงบ ฿${budget}/วันแล้ว`)} />
    </div>
  </div>
}

function CampaignRow({ campaign, selected, onSelect, onAction }: { campaign: Campaign; selected: boolean; onSelect: () => void; onAction: () => void }) {
  const meta = campaignStatus[campaign.status]
  return <tr onClick={onSelect} className={`min-h-[44px] cursor-pointer border-b border-line last:border-0 ${selected ? 'bg-brand-tint/40' : 'hover:bg-canvas/60'}`}>
    <td className="px-4 py-3 text-sm font-medium">{campaign.brand}</td><td className="px-4 py-3 text-sm">{campaign.name}</td><td className="px-4 py-3"><Chip tone={meta.tone} dot>{meta.label}</Chip></td><td className="num px-4 py-3 text-sm">฿{campaign.budget.toLocaleString()}</td><td className="num px-4 py-3 text-sm">{campaign.keywords.length}</td><td className="max-w-[160px] px-4 py-3"><p className="truncate font-mono text-xs text-sub" title={campaign.url}>{campaign.url}</p></td><td className="px-4 py-3"><p className="font-mono text-xs">{campaign.job}</p><p className="text-xs text-sub">{campaign.time}</p></td><td className="px-4 py-3" onClick={(e) => e.stopPropagation()}><CampaignAction campaign={campaign} onAction={onAction} /></td>
  </tr>
}

function CampaignAction({ campaign, onAction }: { campaign: Campaign; onAction: () => void }) {
  if (campaign.status === 'building') return <Button size="sm" disabled>กำลังสร้าง</Button>
  if (campaign.status === 'active') return <Button size="sm" onClick={onAction} icon={<ExternalLink className="h-3.5 w-3.5" />}>ดูใน Google Ads</Button>
  const label = campaign.status === 'draft' ? 'ส่งสร้าง' : campaign.status === 'failed' ? 'ลองใหม่' : 'เปิดใช้อีกครั้ง'
  return <Button size="sm" variant="primary" icon={<RotateCcw aria-hidden="true" className="h-3.5 w-3.5"/>} onClick={onAction}>{label}</Button>
}

function CampaignDetail({ campaign, budget, setBudget, onSaved }: { campaign: Campaign; budget: string; setBudget: (v: string) => void; onSaved: () => void }) {
  const meta = campaignStatus[campaign.status]
  return <Card className="xl:sticky xl:top-6" bodyClassName="p-0"><div className="border-b border-line p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium">{campaign.brand}</p><h2 className="mt-1 text-base font-semibold">{campaign.name}</h2></div><Chip tone={meta.tone} dot>{meta.label}</Chip></div></div><div className="border-b border-line p-5"><label htmlFor="campaign-budget" className="text-sm font-medium">งบต่อวัน</label><div className="mt-2 flex gap-2"><div className="relative flex-1"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-sub">฿</span><input id="campaign-budget" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ''))} className="focus-ring num h-11 w-full rounded-xl border border-line bg-white pl-7 pr-3 text-sm" /></div><Button size="sm" variant="primary" icon={<Save aria-hidden="true" className="h-3.5 w-3.5"/>} onClick={onSaved}>บันทึก</Button></div></div><div className="border-b border-line p-5"><h3 className="text-sm font-semibold">คีย์เวิร์ด</h3><div className="mt-3 flex flex-wrap gap-2">{campaign.keywords.map((k) => <Chip key={k} tone="neutral">{k}</Chip>)}</div></div><div className="p-5"><h3 className="text-sm font-semibold">Job log</h3><ol className="mt-3 space-y-3">{campaign.log.map((log, i) => <li key={`${log.state}-${i}`} className="flex gap-3"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotTone(log.tone)}`} /><div className="min-w-0 flex-1"><p className="font-mono text-xs text-ink">{log.state}</p><p className="text-xs text-sub">{log.time}</p></div></li>)}</ol></div></Card>
}
function dotTone(tone: string) { return ({ success: 'bg-ok', warning: 'bg-warn', danger: 'bg-bad', info: 'bg-info', neutral: 'bg-[#97979B]', accent: 'bg-brand' } as Record<string, string>)[tone] }
