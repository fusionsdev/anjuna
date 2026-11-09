import React from 'react'
import { Card } from '../ui/Card'
import { SourceChip } from '../ui/SourceChip'

export interface BrandForm { name: string; domain: string; keywords: string; phone: string; address: string; email: string }
export function BrandInfoStep({ value, onChange }: { value: BrandForm; onChange: (key: keyof BrandForm, value: string) => void }) {
  const field = (key: keyof BrandForm, label: string, placeholder: string, type = 'text') => (
    <div>
      <label htmlFor={key} className="text-sm font-medium">{label}</label>
      <input id={key} type={type} value={value[key]} onChange={(e) => onChange(key, e.target.value)} placeholder={placeholder} className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-white px-3 text-sm placeholder:text-sub" />
    </div>
  )
  return <Card title="ข้อมูลแบรนด์" source={<SourceChip>ร่างแบรนด์ · บันทึกอัตโนมัติ</SourceChip>}>
    <div className="grid gap-4 md:grid-cols-2">
      {field('name', 'ชื่อแบรนด์', 'เช่น Maple Pet Credit')}
      {field('domain', 'โดเมนหลัก (apex)', 'เช่น maplepetcredit.com')}
      <div className="md:col-span-2">{field('keywords', 'คีย์เวิร์ดหลัก', 'เช่น สินเชื่อสัตว์เลี้ยง, เงินกู้ค่ารักษาสัตว์')}</div>
      {field('phone', 'โทรศัพท์', 'เช่น 02-000-0000', 'tel')}
      {field('email', 'อีเมล', 'เช่น help@maplepetcredit.com', 'email')}
      <div className="md:col-span-2">
        <label htmlFor="address" className="text-sm font-medium">ที่อยู่</label>
        <textarea id="address" rows={3} value={value.address} onChange={(e) => onChange('address', e.target.value)} className="focus-ring mt-1.5 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm" />
      </div>
    </div>
  </Card>
}
