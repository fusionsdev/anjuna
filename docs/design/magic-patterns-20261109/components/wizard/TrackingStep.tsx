import React from 'react'
import { CheckCircle2, Lock } from 'lucide-react'
import { Card } from '../ui/Card'
import { Chip } from '../ui/Chip'
import { SourceChip } from '../ui/SourceChip'
import { SelectField } from './SelectField'
import { adkitProjects, adsAccounts, existingActions } from '../../data/wizard'

export type ActionMode = 'new' | 'existing'

interface TrackingStepProps {
  project: string
  setProject: (v: string) => void
  account: string
  setAccount: (v: string) => void
  mode: ActionMode
  setMode: (m: ActionMode) => void
  existing: string
  setExisting: (v: string) => void
}

export function TrackingStep({ project, setProject, account, setAccount, mode, setMode, existing, setExisting }: TrackingStepProps) {
  const currency = adsAccounts.find((a) => a.id === account)?.currency ?? '—'
  return (
    <div className="space-y-6">
      <Card title="บัญชีที่เชื่อม" source={<SourceChip>AdKit · ดึงรายการเมื่อ 2 นาทีที่แล้ว</SourceChip>}>
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField id="adkit-project" label="AdKit project" value={project} onChange={setProject} options={adkitProjects} hint="เลือกจากโปรเจกต์ใน AdKit ที่คุณมีสิทธิ์" />
          <SelectField id="ads-account" label="บัญชี Google Ads" value={account} onChange={setAccount} options={adsAccounts} hint="บัญชีที่ผูกกับโปรเจกต์นี้ใน AdKit" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-canvas px-4 py-3">
          <Lock className="h-4 w-4 text-sub" aria-hidden="true" />
          <span className="text-sm">สกุลเงิน</span>
          <span className="num rounded-md border border-line bg-white px-2 py-0.5 text-sm font-semibold">{currency}</span>
          <Chip tone="info">ตรวจพบอัตโนมัติจากบัญชี Google Ads</Chip>
        </div>
      </Card>

      <Card title="Conversion action" source={<SourceChip>Google Ads API ผ่าน AdKit</SourceChip>}>
        <fieldset>
          <legend className="sr-only">เลือก conversion action</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <RadioCard
              checked={mode === 'new'}
              onChange={() => setMode('new')}
              title="สร้างใหม่ให้แบรนด์นี้"
              badge="แนะนำ"
              description="แยกข้อมูลคอนเวอร์ชันของแบรนด์นี้ชัดเจน ไม่ปนกับแบรนด์อื่น"
            />
            <RadioCard
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
              title="ใช้ action ที่มีอยู่"
              description="ใช้ร่วมกับแบรนด์อื่นในบัญชีเดียวกัน รายงานจะรวมกัน"
            />
          </div>
        </fieldset>

        {mode === 'new' ? (
          <div role="status" className="mt-4 flex items-start gap-3 rounded-xl border border-[#BFE3D1] bg-ok-bg px-4 py-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden="true" />
            <div className="text-sm text-ok">
              <p className="font-medium">
                สร้าง conversion action แล้ว: <span className="num">cv-9405e324a67f3565</span>
              </p>
              <p className="num mt-0.5 text-xs">job_2f8c1a · 11 วินาที</p>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <SelectField id="existing-action" label="เลือก conversion action" value={existing} onChange={setExisting} options={existingActions} />
          </div>
        )}
      </Card>
    </div>
  )
}

interface RadioCardProps {
  checked: boolean
  onChange: () => void
  title: string
  description: string
  badge?: string
}

function RadioCard({ checked, onChange, title, description, badge }: RadioCardProps) {
  return (
    <label
      className={`flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-2 ${
        checked ? 'border-brand bg-brand-tint/40' : 'border-line bg-white hover:bg-canvas'
      }`}
    >
      <input type="radio" name="conversion-action" checked={checked} onChange={onChange} className="mt-0.5 h-4 w-4 accent-[#F83808] focus:outline-none" />
      <span>
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {badge && <Chip tone="accent">{badge}</Chip>}
        </span>
        <span className="mt-1 block text-xs text-sub">{description}</span>
      </span>
    </label>
  )
}
