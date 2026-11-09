import type { PageId, Tone } from '../types/app'

export const fixItems: { id: string; brandId: string; brand: string; issue: string; detail: string; tone: Tone; action: string; primary: boolean }[] = [
  { id: 'f1', brandId: 'petvetpay', brand: 'PetVetPay', issue: 'ลีดไม่มี gclid', detail: '18 ลีดล่าสุดไม่มี gclid จึงอัปโหลดคอนเวอร์ชันไม่ได้', tone: 'warning', action: 'ตรวจ gclid', primary: false },
  { id: 'f2', brandId: 'withuaon', brand: 'withuaon.com', issue: 'ติดตั้งล้มเหลวที่ขั้นโดเมน', detail: 'DNS ยังไม่ชี้มาที่ Anjuna · ลองครั้งล่าสุด 09:42', tone: 'danger', action: 'ลองใหม่', primary: true },
  { id: 'f3', brandId: 'willow', brand: 'Willow Lending', issue: 'ยังไม่มี drain route', detail: 'คอนเวอร์ชัน 4 รายการค้างอยู่ ส่งเข้า Google Ads ไม่ได้', tone: 'danger', action: 'ตั้ง drain route', primary: false },
  { id: 'f4', brandId: 'demo06', brand: 'demo06', issue: 'อัตราปฏิเสธ 100%', detail: 'LeadsGate ปฏิเสธ 6/6 ลีดใน 24 ชั่วโมงที่ผ่านมา', tone: 'warning', action: 'ดูลีด', primary: false }
]

export const humanTasks: { id: string; label: string; count: number; unit: string; action: string; page: PageId }[] = [
  { id: 'h1', label: 'ยืนยัน Test sold', count: 29, unit: 'แบรนด์', action: 'ยืนยัน', page: 'brands' },
  { id: 'h2', label: 'อนุมัติเทมเพลต', count: 4, unit: 'รายการ', action: 'ตรวจ', page: 'templates' },
  { id: 'h3', label: 'ตั้ง drain route', count: 2, unit: 'แบรนด์', action: 'ตั้งค่า', page: 'brands' },
  { id: 'h4', label: 'ร่างที่ยังไม่กดสร้าง', count: 1, unit: 'ร่าง', action: 'ทำต่อ', page: 'new-brand' }
]

export const kpis: { id: string; label: string; value: string; sub?: string; delta?: string; good?: boolean; tag?: string }[] = [
  { id: 'spend', label: 'ค่าโฆษณา', value: '฿12,448', sub: '≈$356', delta: '+8%', good: true },
  { id: 'leads', label: 'ลีด', value: '72', delta: '+12%', good: true },
  { id: 'cpl', label: 'ต้นทุนต่อลีด', value: '฿173', sub: '≈$4.94', delta: '−3%', good: true },
  { id: 'sold', label: 'ขายได้', value: '19', sub: '26% ของลีด', delta: '−2', good: false },
  { id: 'profit', label: 'รายได้ / กำไร', value: '$177 / −$179', tag: 'owner' }
]

export const funnel = [
  { label: 'คลิกโฆษณา', value: 170 },
  { label: 'เข้าหน้าเว็บ', value: 141 },
  { label: 'เริ่มกรอกฟอร์ม', value: 96 },
  { label: 'ลีด', value: 72 },
  { label: 'ขายได้', value: 19 }
]

export const queueStats: { label: string; value: number | null; tone: Tone }[] = [
  { label: 'ส่งแล้ว', value: 15, tone: 'success' },
  { label: 'ค้างส่ง', value: 0, tone: 'neutral' },
  { label: 'ส่งไม่ได้', value: 4, tone: 'danger' },
  { label: 'ค้างเกิน 6 ชม.', value: null, tone: 'warning' }
]
