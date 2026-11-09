import React, { useMemo, useState } from 'react'
import { ArrowLeft, CheckCircle2, Rocket } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Chip } from '../components/ui/Chip'
import { SourceChip } from '../components/ui/SourceChip'
import { BrandInfoStep, type BrandForm } from '../components/wizard/BrandInfoStep'
import { DomainStep } from '../components/wizard/DomainStep'
import { TemplateStep } from '../components/wizard/TemplateStep'
import { TrackingStep, type ActionMode } from '../components/wizard/TrackingStep'
import { WizardStepper } from '../components/wizard/WizardStepper'
import { WizardSummary } from '../components/wizard/WizardSummary'
import { adkitProjects, adsAccounts, wizardSteps } from '../data/wizard'
import { templates } from '../data/templates'

const initialForm: BrandForm = { name: 'Maple Pet Credit', domain: 'maplepetcredit.com', keywords: 'สินเชื่อสัตว์เลี้ยง, เงินกู้ค่ารักษาสัตว์', phone: '02-000-0000', email: 'help@maplepetcredit.com', address: 'กรุงเทพมหานคร' }

export function NewBrand({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState(1)
  const [form, setForm] = useState<BrandForm>(initialForm)
  const [templateId, setTemplateId] = useState('t1')
  const [palette, setPalette] = useState(0)
  const [project, setProject] = useState(adkitProjects[0].id)
  const [account, setAccount] = useState(adsAccounts[0].id)
  const [mode, setMode] = useState<ActionMode>('new')
  const [existing, setExisting] = useState('cv-1')
  const [saved, setSaved] = useState(false)
  const [created, setCreated] = useState(false)
  const selectedTemplate = templates.find((template) => template.id === templateId) ?? templates[0]
  const projectLabel = adkitProjects.find((item) => item.id === project)?.label ?? '—'
  const accountLabel = adsAccounts.find((item) => item.id === account)?.label ?? '—'
  const summary = useMemo(() => [
    { label: 'ข้อมูลแบรนด์', value: form.name || 'ยังไม่ได้ตั้งชื่อ', done: !!form.name && step > 1 },
    { label: 'เทมเพลต', value: `${selectedTemplate.name} · v${selectedTemplate.version}`, done: !!templateId && step > 2 },
    { label: 'โดเมน', value: form.domain || 'ยังไม่ได้ตั้งค่า', done: !!form.domain && step > 3 },
    { label: 'AdKit project', value: projectLabel, done: step > 4 },
    { label: 'Google Ads', value: `${accountLabel} · THB`, done: step > 4 },
    { label: 'Conversion action', value: mode === 'new' ? 'cv-9405e324a67f3565' : 'ใช้ action ที่มีอยู่', done: step > 4 },
    { label: 'ตรวจและสร้าง', value: created ? 'สร้างเว็บไซต์แล้ว' : 'ยังไม่ได้กดสร้าง', done: created }
  ], [accountLabel, created, form.domain, form.name, mode, projectLabel, selectedTemplate.name, selectedTemplate.version, step, templateId])
  const next = () => { if (step < 5) setStep((current) => current + 1) }
  const previous = () => { if (step > 1) setStep((current) => current - 1) }
  const updateForm = (key: keyof BrandForm, value: string) => setForm((current) => ({ ...current, [key]: value }))
  return <div className="space-y-6"><div><button type="button" onClick={onBack} className="focus-ring -ml-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-2 text-[15px] text-sub hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden="true"/>กลับไปที่แบรนด์</button><h1 className="mb-1 mt-1 text-[28px] font-semibold leading-[1.25] tracking-[-0.01em] text-ink">สร้างแบรนด์ใหม่</h1><p className="text-[15px] text-sub">ขั้นที่ <span className="num">{step}</span> จาก <span className="num">5</span> · {wizardSteps[step - 1]}</p></div><WizardStepper current={step} onStepClick={setStep}/><div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]"><div className="space-y-5">{step === 1 && <BrandInfoStep value={form} onChange={updateForm}/>} {step === 2 && <TemplateStep selected={templateId} onSelect={setTemplateId} palette={palette} onPalette={setPalette}/>} {step === 3 && <DomainStep domain={form.domain}/>} {step === 4 && <TrackingStep project={project} setProject={setProject} account={account} setAccount={setAccount} mode={mode} setMode={setMode} existing={existing} setExisting={setExisting}/>} {step === 5 && <ReviewStep summary={summary} domain={form.domain} templateName={selectedTemplate.name} onCreate={() => setCreated(true)} created={created}/>}<div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between"><Button onClick={previous} disabled={step === 1}>ย้อนกลับ</Button><div className="flex flex-col gap-3 sm:flex-row sm:items-center">{saved && <span role="status" className="inline-flex items-center gap-1.5 text-sm text-ok"><CheckCircle2 className="h-4 w-4" aria-hidden="true"/>บันทึกร่างแล้ว</span>}<Button onClick={() => setSaved(true)}>บันทึกร่าง</Button>{step < 5 && <Button variant="primary" onClick={next}>ถัดไป: {wizardSteps[step]}</Button>}</div></div></div>{step < 5 && <WizardSummary items={summary}/>}</div></div>
}
function ReviewStep({ summary, domain, templateName, onCreate, created }: { summary: { label: string; value: string; done: boolean }[]; domain: string; templateName: string; onCreate: () => void; created: boolean }) { return <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]"><WizardSummary items={summary}/><Card title="ตัวอย่างหน้าเว็บก่อนติดตั้ง"><div className="flex aspect-[16/10] items-center justify-center rounded-xl border border-line bg-canvas p-5 text-center"><div><Rocket className="mx-auto h-5 w-5 text-sub" aria-hidden="true"/><p className="mt-2 text-sm font-medium">ตัวอย่างหน้าเว็บก่อนติดตั้ง</p><p className="mt-1 text-xs text-sub">{templateName} · {domain || 'ยังไม่ได้ตั้งค่าโดเมน'}</p></div></div><div className="mt-4"><Button variant="primary" className="w-full" icon={<Rocket aria-hidden="true" className="h-4 w-4"/>} onClick={onCreate}>สร้างเว็บไซต์</Button><p className="mt-2 text-center text-xs text-sub">เจ้าของเท่านั้น</p>{created && <p role="status" className="mt-3 text-center text-sm font-medium text-ok">ส่งงานสร้างเว็บไซต์แล้ว</p>}</div></Card></div>}
