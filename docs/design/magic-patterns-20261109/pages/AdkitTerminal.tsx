import React, { useMemo, useState } from 'react'
import { AlertTriangle, Play, RefreshCw, Terminal } from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Chip } from '../components/ui/Chip'
import { SourceChip } from '../components/ui/SourceChip'
import { Button } from '../components/ui/Button'
import { adkitJobs, jobStatus } from '../data/operations'
import { ScopeSubtitle } from '../components/ui/ScopeSubtitle'
import type { BrandScope } from '../types/app'

const quickActions = ['ซิงก์ค่าโฆษณา', 'เขียน Final URL suffix', 'ตรวจ conversion action', 'ดึงรายการบัญชี']

export function AdkitTerminal({ scope, onEditScope }: { scope: BrandScope; onEditScope: () => void }) {
  const [selectedId, setSelectedId] = useState(adkitJobs[0].id)
  const [command, setCommand] = useState('')
  const [echoes, setEchoes] = useState<string[]>([])
  const [confirmWrite, setConfirmWrite] = useState(false)
  const selected = adkitJobs.find((job) => job.id === selectedId) ?? adkitJobs[0]
  const logs = useMemo(() => [...selected.logs, ...echoes], [selected.logs, echoes])
  const run = (nextCommand = command) => { if (!nextCommand.trim()) return; setEchoes((lines) => [...lines, `${new Date().toLocaleTimeString('en-GB')} echo ${nextCommand.trim()}`, `${new Date().toLocaleTimeString('en-GB')} queued command`]); setCommand(''); setConfirmWrite(false) }
  return <div className="space-y-5"><PageHeader icon={Terminal} title="AdKit Terminal" subtitle={<ScopeSubtitle scope={scope} onEdit={onEditScope}>สั่งงาน AdKit และดูผลงาน (เฉพาะเจ้าของ)</ScopeSubtitle>} />
    <div role="alert" className="flex items-start gap-3 rounded-card border border-[#F2D49A] bg-warn-bg px-5 py-4 text-warn"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0"/><p className="text-sm font-medium">งานที่เขียนเข้า Google Ads ต้องยืนยันก่อนรัน</p></div>
    <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]"><Card title="งานล่าสุด" source={<SourceChip>D1 · adkit_jobs</SourceChip>} bodyClassName="p-0"><ul className="divide-y divide-line">{adkitJobs.map((job) => { const meta = jobStatus[job.status]; return <li key={job.id}><button type="button" aria-pressed={job.id === selected.id} onClick={() => { setSelectedId(job.id); setEchoes([]) }} className={`focus-ring flex min-h-[76px] w-full items-start gap-3 p-4 text-left ${job.id === selected.id ? 'bg-brand-tint/40' : 'hover:bg-canvas/60'}`}><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot(meta.tone)}`}/><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="font-mono text-xs font-medium">{job.id}</span><span className="text-xs text-sub">{job.time}</span></span><span className="mt-1 block text-sm font-medium">{job.type}</span><span className="mt-0.5 flex flex-wrap items-center gap-2"><span className="text-xs text-sub">{job.brand}</span><Chip tone={meta.tone}>{meta.label}</Chip></span></span></button></li> })}</ul></Card>
      <div className="space-y-4"><div className="flex flex-wrap gap-2">{quickActions.map((action) => <Button key={action} size="sm" icon={<RefreshCw aria-hidden="true" className="h-3.5 w-3.5"/>} onClick={() => action === 'เขียน Final URL suffix' ? setConfirmWrite(true) : run(action)}>{action}</Button>)}</div>{confirmWrite && <div role="dialog" aria-label="ยืนยันการเขียน Final URL suffix" className="rounded-card border border-[#F2D49A] bg-warn-bg p-4"><p className="text-sm font-medium text-warn">ยืนยันเขียน Final URL suffix เข้า Google Ads สำหรับงานที่เลือก?</p><div className="mt-3 flex gap-2"><Button size="sm" variant="primary" onClick={() => run('write-final-url-suffix')}>ยืนยันและรัน</Button><Button size="sm" onClick={() => setConfirmWrite(false)}>ยกเลิก</Button></div></div>}
        <section className="overflow-hidden rounded-card bg-ink text-[#E8E8E6]"><header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-5 py-4"><h2 className="font-mono text-sm font-medium">$ adkit logs --job {selected.id}</h2><Chip tone={jobStatus[selected.status].tone}>{jobStatus[selected.status].label}</Chip></header><div className="min-h-[360px] max-h-[500px] overflow-y-auto p-5 font-mono text-[13px] leading-relaxed"><p className="text-white/50"># {selected.type} · {selected.brand}</p>{logs.map((line, index) => <p key={`${line}-${index}`} className="mt-1 break-words">{line}</p>)}</div><div className="flex gap-2 border-t border-white/10 p-3"><input value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="พิมพ์คำสั่ง เช่น sync-spend --brand petplanloans" className="focus-ring h-11 min-w-0 flex-1 rounded-xl border border-white/20 bg-white/5 px-3 font-mono text-[13px] text-[#E8E8E6] placeholder:text-white/45"/><Button variant="primary" icon={<Play className="h-4 w-4"/>} onClick={() => run()}>รัน</Button></div></section></div></div>
  </div>
}
function dot(tone: string) { return ({ success: 'bg-ok', warning: 'bg-warn', danger: 'bg-bad', info: 'bg-info', neutral: 'bg-[#99999D]', accent: 'bg-brand' } as Record<string, string>)[tone] }
