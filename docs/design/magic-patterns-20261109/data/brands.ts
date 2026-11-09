import type { Brand } from '../types/app'

export const stageLabels = ['สร้าง', 'เทมเพลต', 'ดีพลอย', 'โดเมน', 'ลีด', 'ขายได้', 'อัปโหลด']

export const homeBrandIds = ['petplanloans', 'petvetpay', 'willow', 'withuaon', 'cedarline']

export const brands: Brand[] = [
  {
    id: 'petplanloans',
    name: 'PetPlanLoans',
    domain: 'petplanloans.com',
    stages: ['done', 'done', 'done', 'done', 'done', 'done', 'done'],
    spend: 4820,
    leads: 31,
    cpl: 155,
    ads: { label: 'ใช้งาน', tone: 'success' },
    action: { label: 'ดูรายละเอียด', primary: false },
    state: 'active',
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'ok', detail: 'SSL ใช้งานได้ · ตอบสนอง 212ms' },
      { label: 'Postback LeadsGate', status: 'ok', detail: 'รับ postback ล่าสุด 10:48' },
      { label: 'Test sold', status: 'ok', detail: 'ยืนยันแล้วเมื่อ 2 พ.ย.' },
      { label: 'Drain route', status: 'ok', detail: 'ส่งเข้า Google Ads · PetPlan TH' }
    ],
    adkit: { spend: 4820, leads: 31, failedUploads: 0, updated: '14 นาทีที่แล้ว' }
  },
  {
    id: 'petvetpay',
    name: 'PetVetPay',
    domain: 'petvetpay.co',
    stages: ['done', 'done', 'done', 'done', 'warn', 'done', 'warn'],
    spend: 3210,
    leads: 18,
    cpl: 178,
    ads: { label: 'ไม่มี gclid', tone: 'warning' },
    action: { label: 'ตรวจ gclid', primary: true },
    state: 'fix',
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'ok', detail: 'SSL ใช้งานได้ · ตอบสนอง 240ms' },
      { label: 'Postback LeadsGate', status: 'fail', detail: 'Postback ไม่ส่ง gclid กลับมาใน 18 ลีดล่าสุด', fixLabel: 'ตรวจ gclid' },
      { label: 'Test sold', status: 'ok', detail: 'ยืนยันแล้วเมื่อ 28 ต.ค.' },
      { label: 'Drain route', status: 'ok', detail: 'ส่งเข้า Google Ads · PetVet TH' }
    ],
    adkit: { spend: 3210, leads: 18, failedUploads: null, updated: '14 นาทีที่แล้ว' }
  },
  {
    id: 'willow',
    name: 'Willow Lending',
    domain: 'willowlending.com',
    stages: ['done', 'done', 'done', 'done', 'done', 'done', 'fail'],
    spend: 2650,
    leads: 15,
    cpl: 177,
    ads: { label: 'ใช้งาน', tone: 'success' },
    action: { label: 'ตั้ง drain route', primary: true },
    state: 'fix',
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'ok', detail: 'SSL ใช้งานได้ · ตอบสนอง 198ms' },
      { label: 'Postback LeadsGate', status: 'ok', detail: 'รับ postback ล่าสุด 10:31' },
      { label: 'Test sold', status: 'ok', detail: 'ยืนยันแล้วเมื่อ 1 พ.ย.' },
      { label: 'Drain route', status: 'fail', detail: 'ยังไม่ได้เลือกปลายทาง — คอนเวอร์ชัน 4 รายการค้างอยู่', fixLabel: 'ตั้ง drain route' }
    ],
    adkit: { spend: 2650, leads: 15, failedUploads: 4, updated: '14 นาทีที่แล้ว' }
  },
  {
    id: 'withuaon',
    name: 'withuaon.com',
    domain: 'withuaon.com',
    stages: ['done', 'done', 'done', 'fail', 'pending', 'pending', 'pending'],
    spend: null,
    leads: null,
    cpl: null,
    ads: { label: 'ยังไม่เชื่อม', tone: 'neutral' },
    action: { label: 'ลองใหม่', primary: true },
    state: 'fix',
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'fail', detail: 'ติดตั้งล้มเหลวที่ขั้นโดเมน — DNS ยังไม่ชี้มาที่ Anjuna', fixLabel: 'ลองใหม่' },
      { label: 'Postback LeadsGate', status: 'pending', detail: 'รอเว็บขึ้นก่อน' },
      { label: 'Test sold', status: 'pending', detail: 'รอเว็บขึ้นก่อน' },
      { label: 'Drain route', status: 'pending', detail: 'รอเชื่อม Google Ads' }
    ],
    adkit: { spend: null, leads: null, failedUploads: null, updated: '—' }
  },
  {
    id: 'cedarline',
    name: 'Cedarline Cash',
    domain: 'cedarlinecash.com',
    stages: ['done', 'done', 'done', 'done', 'done', 'warn', 'pending'],
    spend: 1768,
    leads: 8,
    cpl: 221,
    ads: { label: 'กำลังเรียนรู้', tone: 'info' },
    action: { label: 'ยืนยัน Test sold', primary: true },
    state: 'incomplete',
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'ok', detail: 'SSL ใช้งานได้ · ตอบสนอง 230ms' },
      { label: 'Postback LeadsGate', status: 'ok', detail: 'รับ postback ล่าสุด 09:57' },
      { label: 'Test sold', status: 'fail', detail: 'ส่งลีดทดสอบแล้ว รอยืนยันว่าขายได้', fixLabel: 'ยืนยัน Test sold' },
      { label: 'Drain route', status: 'ok', detail: 'ส่งเข้า Google Ads · Cedarline TH' }
    ],
    adkit: { spend: 1768, leads: 8, failedUploads: 0, updated: '14 นาทีที่แล้ว' }
  },
  {
    id: 'ridgeway',
    name: 'Ridgeway Pet Care',
    domain: 'ridgewaypet.com',
    stages: ['done', 'done', 'done', 'done', 'done', 'done', 'done'],
    spend: 1980,
    leads: 12,
    cpl: 165,
    ads: { label: 'ใช้งาน', tone: 'success' },
    action: { label: 'ดูรายละเอียด', primary: false },
    state: 'active',
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'ok', detail: 'SSL ใช้งานได้ · ตอบสนอง 205ms' },
      { label: 'Postback LeadsGate', status: 'ok', detail: 'รับ postback ล่าสุด 10:40' },
      { label: 'Test sold', status: 'ok', detail: 'ยืนยันแล้วเมื่อ 20 ต.ค.' },
      { label: 'Drain route', status: 'ok', detail: 'ส่งเข้า Google Ads · Ridgeway TH' }
    ],
    adkit: { spend: 1980, leads: 12, failedUploads: 0, updated: '14 นาทีที่แล้ว' }
  },
  {
    id: 'harbor',
    name: 'Harbor Micro Loans',
    domain: 'harbormicro.com',
    stages: ['done', 'done', 'done', 'done', 'done', 'done', 'done'],
    spend: 2310,
    leads: 14,
    cpl: 165,
    ads: { label: 'ใช้งาน', tone: 'success' },
    action: { label: 'ดูรายละเอียด', primary: false },
    state: 'active',
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'ok', detail: 'SSL ใช้งานได้ · ตอบสนอง 188ms' },
      { label: 'Postback LeadsGate', status: 'ok', detail: 'รับ postback ล่าสุด 10:52' },
      { label: 'Test sold', status: 'ok', detail: 'ยืนยันแล้วเมื่อ 15 ต.ค.' },
      { label: 'Drain route', status: 'ok', detail: 'ส่งเข้า Google Ads · Harbor TH' }
    ],
    adkit: { spend: 2310, leads: 14, failedUploads: 0, updated: '14 นาทีที่แล้ว' }
  },
  {
    id: 'fernbrook',
    name: 'Fernbrook Credit',
    domain: 'fernbrookcredit.com',
    stages: ['done', 'done', 'pending', 'pending', 'pending', 'pending', 'pending'],
    spend: null,
    leads: null,
    cpl: null,
    ads: { label: 'ยังไม่เชื่อม', tone: 'neutral' },
    action: { label: 'ทำต่อ', primary: true },
    state: 'incomplete',
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'pending', detail: 'ยังไม่ได้ดีพลอย' },
      { label: 'Postback LeadsGate', status: 'pending', detail: 'รอเว็บขึ้นก่อน' },
      { label: 'Test sold', status: 'pending', detail: 'รอเว็บขึ้นก่อน' },
      { label: 'Drain route', status: 'pending', detail: 'รอเชื่อม Google Ads' }
    ],
    adkit: { spend: null, leads: null, failedUploads: null, updated: '—' }
  },
  {
    id: 'lumen',
    name: 'Lumen Small Biz',
    domain: 'lumensmallbiz.com',
    stages: ['done', 'done', 'done', 'done', 'done', 'done', 'done'],
    spend: null,
    leads: null,
    cpl: null,
    ads: { label: 'หยุดชั่วคราว', tone: 'neutral' },
    action: { label: 'เปิดใช้อีกครั้ง', primary: false },
    state: 'paused',
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'ok', detail: 'SSL ใช้งานได้ · หน้าเว็บแสดงข้อความปิดชั่วคราว' },
      { label: 'Postback LeadsGate', status: 'ok', detail: 'รับ postback ล่าสุด 29 ต.ค.' },
      { label: 'Test sold', status: 'ok', detail: 'ยืนยันแล้วเมื่อ 3 ต.ค.' },
      { label: 'Drain route', status: 'ok', detail: 'ส่งเข้า Google Ads · Lumen TH' }
    ],
    adkit: { spend: null, leads: null, failedUploads: 0, updated: '14 นาทีที่แล้ว' }
  },
  {
    id: 'demo06',
    name: 'demo06',
    domain: 'demo06.anjuna.dev',
    stages: ['done', 'done', 'done', 'done', 'done', 'fail', 'pending'],
    spend: null,
    leads: 6,
    cpl: null,
    ads: { label: 'ทดลอง', tone: 'neutral' },
    action: { label: 'ดูลีด', primary: false },
    state: 'fix',
    isTest: true,
    checklist: [
      { label: 'เว็บขึ้นแล้ว', status: 'ok', detail: 'SSL ใช้งานได้' },
      { label: 'Postback LeadsGate', status: 'ok', detail: 'รับ postback ล่าสุด 10:05' },
      { label: 'Test sold', status: 'fail', detail: 'LeadsGate ปฏิเสธ 6/6 ลีด (100%) ใน 24 ชม.', fixLabel: 'ดูเหตุผลที่ปฏิเสธ' },
      { label: 'Drain route', status: 'pending', detail: 'ไม่ต้องตั้งสำหรับแบรนด์ทดลอง' }
    ],
    adkit: { spend: null, leads: 6, failedUploads: null, updated: '14 นาทีที่แล้ว' }
  },
  ...['Northstar Lending', 'BrightPath Credit', 'Horizon Pet Aid', 'Atlas Cash', 'Evergreen Finance', 'Summit Loan Co.', 'Riverstone Credit', 'Oakline Funding', 'Mosaic Money', 'Clearfield Loans', 'Juniper Finance', 'Parkside Credit'].map<Brand>((name, index) => ({
    id: `active-${index + 1}`,
    name,
    domain: `${name.toLowerCase().replace(/[^a-z]/g, '')}.com`,
    stages: ['done', 'done', 'done', 'done', 'done', 'done', 'done'],
    spend: null,
    leads: null,
    cpl: null,
    ads: { label: 'ใช้งาน', tone: 'success' },
    action: { label: 'ดูรายละเอียด', primary: false },
    state: 'active',
    checklist: [{ label: 'เว็บขึ้นแล้ว', status: 'ok', detail: 'ใช้งานได้' }, { label: 'Postback LeadsGate', status: 'ok', detail: 'เชื่อมต่อแล้ว' }, { label: 'Test sold', status: 'ok', detail: 'ยืนยันแล้ว' }, { label: 'Drain route', status: 'ok', detail: 'ใช้งานได้' }],
    adkit: { spend: null, leads: null, failedUploads: 0, updated: '14 นาทีที่แล้ว' }
  })),
  ...['oldpayday2025.com', 'sunsetlending.net', 'legacyvetloan.org', 'classiccash.org', 'archivefunding.net', 'retiredpetloan.com'].map<Brand>((domain, index) => ({
    id: `retired-${index + 1}`,
    name: ['Old Payday 2025', 'Sunset Lending', 'Legacy Vet Loan', 'Classic Cash', 'Archive Funding', 'Retired Pet Loan'][index],
    domain,
    stages: ['done', 'done', 'done', 'done', 'done', 'done', 'done'],
    spend: null,
    leads: null,
    cpl: null,
    ads: { label: 'เลิกใช้แล้ว', tone: 'neutral' },
    action: { label: 'ดูรายละเอียด', primary: false },
    state: 'retired',
    checklist: [{ label: 'เว็บขึ้นแล้ว', status: 'pending', detail: 'ยกเลิกการใช้งานแล้ว' }, { label: 'Postback LeadsGate', status: 'pending', detail: 'ยกเลิกการใช้งานแล้ว' }, { label: 'Test sold', status: 'pending', detail: '—' }, { label: 'Drain route', status: 'pending', detail: '—' }],
    adkit: { spend: null, leads: null, failedUploads: null, updated: '—' }
  }))
]
