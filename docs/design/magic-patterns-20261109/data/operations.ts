import type { Tone } from '../types/app'

export type CampaignStatus = 'draft' | 'building' | 'active' | 'paused' | 'failed'
export const campaignStatus: Record<CampaignStatus, { label: string; tone: Tone }> = {
  draft: { label: 'ร่าง', tone: 'neutral' }, building: { label: 'กำลังสร้าง', tone: 'info' }, active: { label: 'เปิดใช้', tone: 'success' }, paused: { label: 'หยุด', tone: 'warning' }, failed: { label: 'ล้มเหลว', tone: 'danger' }
}
export interface Campaign { id: string; brand: string; name: string; status: CampaignStatus; budget: number; keywords: string[]; url: string; job: string; time: string; log: { state: string; time: string; tone: Tone }[] }
export const campaigns: Campaign[] = [
  { id: 'cmp-91', brand: 'PetPlanLoans', name: 'TH · Pet loan · Search', status: 'active', budget: 900, keywords: ['สินเชื่อสัตว์เลี้ยง', 'เงินกู้ค่าหมอสัตว์', 'ผ่อนค่ารักษาสัตว์'], url: 'https://petplanloans.com/go?src=google&cid={campaignid}', job: 'job_8a91f2', time: '10:42', log: [{ state: 'queued', time: '10:31', tone: 'neutral' }, { state: 'claimed', time: '10:32', tone: 'info' }, { state: 'done', time: '10:33', tone: 'success' }] },
  { id: 'cmp-76', brand: 'PetVetPay', name: 'TH · Vet care · Search', status: 'failed', budget: 700, keywords: ['สินเชื่อค่ารักษาสัตว์', 'กู้เงินหมอสัตว์'], url: 'https://petvetpay.co/go?src=google&cid={campaignid}', job: 'job_3c58a0', time: '09:42', log: [{ state: 'queued', time: '09:41', tone: 'neutral' }, { state: 'claimed', time: '09:42', tone: 'info' }, { state: 'failed: missing gclid', time: '09:42', tone: 'danger' }] },
  { id: 'cmp-54', brand: 'Willow Lending', name: 'TH · Personal cash · Search', status: 'building', budget: 650, keywords: ['สินเชื่อส่วนบุคคล', 'เงินด่วนออนไลน์'], url: 'https://willowlending.com/go?src=google&cid={campaignid}', job: 'job_4d2e19', time: '08:15', log: [{ state: 'queued', time: '08:15', tone: 'neutral' }, { state: 'claimed', time: '08:16', tone: 'info' }] },
  { id: 'cmp-19', brand: 'Cedarline Cash', name: 'TH · Cash compare · Search', status: 'draft', budget: 500, keywords: ['เปรียบเทียบสินเชื่อ', 'เงินกู้ด่วน'], url: 'https://cedarlinecash.com/go?src=google&cid={campaignid}', job: 'job_draft19', time: 'เมื่อวาน', log: [{ state: 'draft saved', time: 'เมื่อวาน 17:21', tone: 'neutral' }] },
  { id: 'cmp-08', brand: 'Lumen Small Biz', name: 'TH · SME funding · Search', status: 'paused', budget: 850, keywords: ['สินเชื่อ SME', 'เงินทุนธุรกิจ'], url: 'https://lumensmallbiz.com/go?src=google&cid={campaignid}', job: 'job_5ff802', time: '2 พ.ย.', log: [{ state: 'done', time: '2 พ.ย. 13:10', tone: 'success' }, { state: 'paused', time: '2 พ.ย. 14:05', tone: 'warning' }] }
]

export const trafficRows = [
  { brand: 'PetPlanLoans', visits: 141, go: 120, forms: 55, leads: 31 }, { brand: 'PetVetPay', visits: 98, go: 83, forms: 39, leads: 18 }, { brand: 'Willow Lending', visits: 81, go: 70, forms: 32, leads: 15 }, { brand: 'Cedarline Cash', visits: 52, go: 45, forms: 20, leads: 8 }
]
export const webErrors = [
  { time: '10:41', brand: 'withuaon.com', error: 'DNS_PROBE_FINISHED_NXDOMAIN', page: '/', count: 12, tone: 'danger' as Tone, level: 'ผิดพลาด' }, { time: '10:13', brand: 'PetVetPay', error: 'postback_gclid_missing', page: '/go', count: 18, tone: 'warning' as Tone, level: 'คำเตือน' }, { time: '08:54', brand: 'Willow Lending', error: 'drain_route_not_configured', page: '/api/postback', count: 4, tone: 'danger' as Tone, level: 'ผิดพลาด' }
]

export type LeadResult = 'sold' | 'rejected' | 'pending'
export const leadResult: Record<LeadResult, { label: string; tone: Tone }> = { sold: { label: 'ขายได้', tone: 'success' }, rejected: { label: 'ปฏิเสธ', tone: 'danger' }, pending: { label: 'รอผล', tone: 'warning' } }
export interface Lead { id: string; time: string; brand: string; zip: string; amount: string; gclid: boolean; result: LeadResult; value: string; email: string; phone: string; timeline: { label: string; time: string; tone: Tone }[] }
export const leads: Lead[] = [
  { id: 'ld_7c1f', time: '10:48', brand: 'PetPlanLoans', zip: '10110', amount: '฿25,000', gclid: true, result: 'sold', value: '$21', email: 'nara.p@example.test', phone: '08x-xxx-4821', timeline: [{ label: 'ส่งฟอร์ม', time: '10:46', tone: 'info' }, { label: 'redirect LeadsGate', time: '10:46', tone: 'info' }, { label: 'postback ขายได้', time: '10:48', tone: 'success' }, { label: 'ส่งคอนเวอร์ชัน', time: '10:48', tone: 'success' }] },
  { id: 'ld_2a80', time: '10:31', brand: 'PetVetPay', zip: '10240', amount: '฿15,000', gclid: false, result: 'pending', value: '—', email: 'pim.k@example.test', phone: '09x-xxx-1042', timeline: [{ label: 'ส่งฟอร์ม', time: '10:30', tone: 'info' }, { label: 'redirect LeadsGate', time: '10:30', tone: 'info' }, { label: 'รอ postback', time: '10:31', tone: 'warning' }] },
  { id: 'ld_91b0', time: '09:57', brand: 'Cedarline Cash', zip: '10330', amount: '$500', gclid: true, result: 'rejected', value: '—', email: 'mint.s@example.test', phone: '06x-xxx-8110', timeline: [{ label: 'ส่งฟอร์ม', time: '09:55', tone: 'info' }, { label: 'redirect LeadsGate', time: '09:55', tone: 'info' }, { label: 'postback ปฏิเสธ', time: '09:57', tone: 'danger' }] },
  { id: 'ld_648e', time: '09:42', brand: 'Willow Lending', zip: '10400', amount: '฿40,000', gclid: true, result: 'sold', value: '$18', email: 'tida.r@example.test', phone: '08x-xxx-6760', timeline: [{ label: 'ส่งฟอร์ม', time: '09:40', tone: 'info' }, { label: 'redirect LeadsGate', time: '09:40', tone: 'info' }, { label: 'postback ขายได้', time: '09:42', tone: 'success' }, { label: 'ส่งคอนเวอร์ชัน', time: '09:42', tone: 'success' }] }
]
export type ConversionStatus = 'sent' | 'queued' | 'failed' | 'late'
export const conversionStatus: Record<ConversionStatus, { label: string; tone: Tone }> = { sent: { label: 'ส่งแล้ว', tone: 'success' }, queued: { label: 'ค้างส่ง', tone: 'warning' }, failed: { label: 'ส่งไม่ได้', tone: 'danger' }, late: { label: 'ค้างเกิน 6 ชม.', tone: 'warning' } }
export const conversions = [
  { id: 'cv_031', time: '10:48', brand: 'PetPlanLoans', gclid: 'CjwKCAiA71C', value: '$21', status: 'sent' as ConversionStatus, attempts: 1, error: '—' },
  { id: 'cv_030', time: '10:31', brand: 'Willow Lending', gclid: 'CjwKCAi98Kx', value: '$18', status: 'failed' as ConversionStatus, attempts: 3, error: 'drain_route_not_configured' },
  { id: 'cv_029', time: '09:57', brand: 'Willow Lending', gclid: 'CjwKCAi2q4P', value: '$18', status: 'failed' as ConversionStatus, attempts: 3, error: 'drain_route_not_configured' },
  { id: 'cv_028', time: '09:42', brand: 'PetVetPay', gclid: '—', value: '$20', status: 'failed' as ConversionStatus, attempts: 1, error: 'missing_gclid' },
  { id: 'cv_027', time: '08:30', brand: 'PetPlanLoans', gclid: 'CjwKCAiK5u8', value: '$21', status: 'sent' as ConversionStatus, attempts: 1, error: '—' }
]

export type AlertState = 'open' | 'closed'
export const alertItems = [
  { id: 'al_05', state: 'open' as AlertState, tone: 'warning' as Tone, title: 'AdsBot-Google ตรวจหน้า /go', brand: 'PetVetPay', detail: 'AdsBot เข้า petvetpay.co/go · HTTP 200 · 212 ms · ผ่าน gate', found: 'วันนี้ 14:01' },
  { id: 'al_04', state: 'open' as AlertState, tone: 'danger' as Tone, title: 'คอนเวอร์ชันส่งไม่ได้ 4 รายการ', brand: 'Willow Lending', detail: 'ยังไม่มี drain route เพื่อส่ง conversion action เข้า Google Ads', found: 'วันนี้ 10:31' },
  { id: 'al_03', state: 'open' as AlertState, tone: 'warning' as Tone, title: 'ไม่มี gclid ในลีดล่าสุด', brand: 'PetVetPay', detail: '18 ลีดล่าสุดไม่มีค่า gclid — วัดผล Google Ads ไม่ได้', found: 'วันนี้ 10:13' },
  { id: 'al_02', state: 'open' as AlertState, tone: 'danger' as Tone, title: 'โดเมนยังชี้ไม่สำเร็จ', brand: 'withuaon.com', detail: 'ตรวจ DNS 3 ครั้งแล้วไม่พบ A record ของ Anjuna', found: 'วันนี้ 09:42' },
  { id: 'al_01', state: 'closed' as AlertState, tone: 'warning' as Tone, title: 'เว็บตอบสนองช้า', brand: 'Cedarline Cash', detail: 'หน้า /go ตอบสนองเกิน 2 วินาทีติดต่อกัน 4 ครั้ง', found: 'เมื่อวาน 16:20' }
]
export const alertRules = [
  { id: 'r1', label: 'ไม่มี postback เกิน 24 ชม.', enabled: true }, { id: 'r2', label: 'คอนเวอร์ชันส่งไม่ได้ ≥ 1', enabled: true }, { id: 'r3', label: 'อัตราปฏิเสธ ≥ 50% ใน 24 ชม.', enabled: true }, { id: 'r4', label: 'คลิกที่จ่ายหายเกิน 30%', enabled: false }, { id: 'r5', label: 'เว็บตอบช้ากว่า 2 วินาที', enabled: true }, { id: 'r6', label: 'AdsBot เข้าแต่หน้าไม่ตอบ 200', enabled: true }, { id: 'r7', label: 'AdsBot เข้าภายใน 10 นาทีหลัง deploy', enabled: true }, { id: 'r8', label: 'แบรนด์มีค่าโฆษณาแต่ไม่มี landing เกิน 60 นาที', enabled: true }
]

export type JobStatus = 'done' | 'running' | 'failed' | 'queued'
export const jobStatus: Record<JobStatus, { label: string; tone: Tone }> = { done: { label: 'เสร็จแล้ว', tone: 'success' }, running: { label: 'กำลังทำงาน', tone: 'info' }, failed: { label: 'ล้มเหลว', tone: 'danger' }, queued: { label: 'รอคิว', tone: 'warning' } }
export const adkitJobs = [
  { id: 'job_8a91f2', type: 'สร้างแคมเปญ', brand: 'PetPlanLoans', status: 'done' as JobStatus, time: '10:42', logs: ['10:31:02 queued campaign create', '10:32:11 claimed by worker th-02', '10:32:18 POST googleads/campaigns', '10:33:09 final URL suffix applied', '10:33:20 done campaign=224-019-8800'] },
  { id: 'job_3c58a0', type: 'ตรวจ conversion action', brand: 'PetVetPay', status: 'failed' as JobStatus, time: '09:42', logs: ['09:41:04 queued conversion check', '09:42:08 claimed by worker th-01', '09:42:19 failed missing gclid in click payload'] },
  { id: 'job_4d2e19', type: 'เขียน Final URL suffix', brand: 'Willow Lending', status: 'running' as JobStatus, time: '08:15', logs: ['08:15:02 queued URL suffix job', '08:16:11 claimed by worker th-03', '08:16:18 verifying destination policy'] },
  { id: 'job_5ff802', type: 'ซิงก์ค่าโฆษณา', brand: 'ทุกแบรนด์', status: 'done' as JobStatus, time: '07:55', logs: ['07:55:00 queued sync', '07:55:12 claimed', '07:56:44 fetched 28 campaigns', '07:56:50 done'] }
]

export const settingsSections = ['ทั่วไป', 'ช่องทางแจ้งเตือน', 'จัดสรรค่าโฆษณา', 'ผู้ใช้', 'รายชื่ออีเมล', 'อีเมลที่บล็อก', 'ประวัติการแก้ไข', 'คีย์ Builder']

export const trendBuckets = [
  [11, 5, 2], [14, 6, 2], [18, 8, 3], [16, 7, 3], [13, 6, 2], [10, 4, 1], [9, 3, 1], [12, 5, 2], [17, 7, 3], [21, 9, 4], [19, 8, 3], [15, 6, 2],
  [12, 5, 2], [16, 7, 3], [20, 9, 4], [23, 11, 5], [22, 10, 4], [18, 8, 3], [16, 7, 3], [14, 6, 2], [13, 5, 2], [15, 6, 2], [18, 8, 3], [20, 9, 4]
]

export const breakdowns = {
  source: [{ label: 'unknown', count: 24, percent: '100%' }],
  host: [{ label: 'enablyloan.com', count: 9, percent: '37.5%' }, { label: 'skratchplans.com', count: 5, percent: '20.8%' }, { label: 'skratchpayoptions.com', count: 3, percent: '12.5%' }, { label: 'simplevetcare.com', count: 3, percent: '12.5%' }, { label: 'lendingbaddies.com', count: 3, percent: '12.5%' }, { label: 'deercreeklending.com', count: 1, percent: '4.2%' }],
  device: [{ label: 'desktop', count: 18, percent: '75%' }, { label: 'mobile', count: 6, percent: '25%' }],
  browser: [{ label: 'chrome', count: 12, percent: '50%' }, { label: 'unknown', count: 6, percent: '25%' }, { label: 'safari', count: 3, percent: '12.5%' }, { label: 'other', count: 3, percent: '12.5%' }],
  brand: [{ label: 'AURUM', count: 9, percent: '37.5%' }, { label: 'SKRATCH', count: 5, percent: '20.8%' }, { label: 'VETCARE', count: 3, percent: '12.5%' }, { label: 'LENDING', count: 4, percent: '16.7%' }, { label: 'DEERCREEK', count: 3, percent: '12.5%' }]
}

export const botRows = [
  { brand: 'AURUM', googlebot: 14, adsbot: 5, other: 2 }, { brand: 'SKRATCH', googlebot: 8, adsbot: 3, other: 1 }, { brand: 'VETCARE', googlebot: 5, adsbot: 2, other: 1 }, { brand: 'LENDING', googlebot: 4, adsbot: 1, other: 0 }
]
export const botNow = [{ label: 'Googlebot', fifteen: 3, hour: 11, day: 31 }, { label: 'AdsBot', fifteen: 1, hour: 5, day: 11 }, { label: 'บอทอื่น', fifteen: 0, hour: 2, day: 4 }]
export const adsbotVisits = [{ brand: 'PetVetPay', url: 'petvetpay.co/go', time: '14:01:10', http: 200, response: '212 ms', gate: 'ผ่าน' }, { brand: 'PetPlanLoans', url: 'petplanloans.com/go', time: '13:42:28', http: 200, response: '198 ms', gate: 'ผ่าน' }, { brand: 'Willow Lending', url: 'willowlending.com/go', time: '12:18:02', http: 302, response: '420 ms', gate: 'ไม่ผ่าน' }]
export const liveSessions = [
  { sessionRef: '851935fb-97b1-4d7f-aec2', hostname: 'enablyloan.com', brand: 'AURUM', device: 'desktop', browser: 'chrome', stage: 'landing_viewed', time: '14:01:02' },
  { sessionRef: '851935fb-97b1-4d7f-aec2', hostname: 'enablyloan.com', brand: 'AURUM', device: 'desktop', browser: 'chrome', stage: 'form_started', time: '14:01:06' },
  { sessionRef: '851935fb-97b1-4d7f-aec2', hostname: 'enablyloan.com', brand: 'AURUM', device: 'desktop', browser: 'chrome', stage: 'form_step_viewed 1', time: '14:01:10' },
  { sessionRef: '851935fb-97b1-4d7f-aec2', hostname: 'enablyloan.com', brand: 'AURUM', device: 'desktop', browser: 'chrome', stage: 'lead_submitted', time: '14:01:14' },
  { sessionRef: 'c4c92ac1-18d2-41a0-b483', hostname: 'skratchplans.com', brand: 'SKRATCH', device: 'mobile', browser: 'safari', stage: 'landing_viewed', time: '14:01:18' },
  { sessionRef: 'c4c92ac1-18d2-41a0-b483', hostname: 'skratchplans.com', brand: 'SKRATCH', device: 'mobile', browser: 'safari', stage: 'form_started', time: '14:01:21' },
  { sessionRef: '8df84db2-2b30-4304-af70', hostname: 'simplevetcare.com', brand: 'VETCARE', device: 'desktop', browser: 'chrome', stage: 'landing_viewed', time: '14:01:25' },
  { sessionRef: '8df84db2-2b30-4304-af70', hostname: 'simplevetcare.com', brand: 'VETCARE', device: 'desktop', browser: 'chrome', stage: 'form_started', time: '14:01:28' },
  { sessionRef: '8df84db2-2b30-4304-af70', hostname: 'simplevetcare.com', brand: 'VETCARE', device: 'desktop', browser: 'chrome', stage: 'form_step_viewed 1', time: '14:01:31' },
  { sessionRef: 'a802f2a1-c8f0-4001-a1e2', hostname: 'lendingbaddies.com', brand: 'LENDING', device: 'desktop', browser: 'unknown', stage: 'landing_viewed', time: '14:01:35' },
  { sessionRef: 'a802f2a1-c8f0-4001-a1e2', hostname: 'lendingbaddies.com', brand: 'LENDING', device: 'desktop', browser: 'unknown', stage: 'gate_viewed', time: '14:01:37' },
  { sessionRef: 'a802f2a1-c8f0-4001-a1e2', hostname: 'lendingbaddies.com', brand: 'LENDING', device: 'desktop', browser: 'unknown', stage: 'lead_submitted', time: '14:01:40' },
  { sessionRef: 'adsbot-4110-97b1-2001', hostname: 'petvetpay.co', brand: 'PetVetPay', device: 'bot', browser: 'AdsBot-Google', stage: 'AdsBot ผ่าน gate', time: '14:01:10', bot: 'AdsBot', http: 200, response: '212 ms', country: 'US' },
  { sessionRef: 'adsbot-4110-97b1-2001', hostname: 'petvetpay.co', brand: 'PetVetPay', device: 'bot', browser: 'AdsBot-Google', stage: 'landing_viewed', time: '14:01:11', bot: 'AdsBot', http: 200, response: '212 ms', country: 'US' },
  { sessionRef: 'postback-8271-941a-0440', hostname: 'petplanloans.com', brand: 'PetPlanLoans', device: 'desktop', browser: 'chrome', stage: 'LeadsGate ขายได้', time: '14:01:44', country: 'US', gclid: true },
  { sessionRef: 'error-5521-19e1-0002', hostname: 'willowlending.com', brand: 'Willow Lending', device: 'mobile', browser: 'chrome', stage: 'error: redirect_timeout', time: '14:01:48', country: 'TH', error: 'redirect_timeout' },
  { sessionRef: 'postback-8271-992b-0952', hostname: 'cedarlinecash.com', brand: 'Cedarline Cash', device: 'desktop', browser: 'chrome', stage: 'LeadsGate ปฏิเสธ', time: '14:01:50', country: 'US', gclid: true }
]

export const recentEvents = [
  ['Nov 09, 14:01:10', '851935fb-97b…', 'form_step_viewed', 'enablyloan.com', 'AURUM', 'unknown', '—', 'desktop', 'chrome', '1', '—', 'unknown'],
  ['Nov 09, 14:01:06', '851935fb-97b…', 'form_started', 'enablyloan.com', 'AURUM', 'unknown', '—', 'desktop', 'chrome', '—', '—', 'unknown'],
  ['Nov 09, 14:01:02', '851935fb-97b…', 'landing_viewed', 'enablyloan.com', 'AURUM', 'unknown', '—', 'desktop', 'chrome', '—', '—', 'unknown'],
  ['Nov 09, 14:00:51', 'c4c92ac1-18d…', 'lead_submitted', 'skratchplans.com', 'SKRATCH', 'unknown', '—', 'mobile', 'safari', '3', '—', 'build_4d9'],
  ['Nov 09, 14:00:44', 'c4c92ac1-18d…', 'form_step_viewed', 'skratchplans.com', 'SKRATCH', 'unknown', '—', 'mobile', 'safari', '2', '—', 'build_4d9'],
  ['Nov 09, 14:00:33', 'c4c92ac1-18d…', 'form_started', 'skratchplans.com', 'SKRATCH', 'unknown', '—', 'mobile', 'safari', '—', '—', 'build_4d9'],
  ['Nov 09, 13:59:59', '8df84db2-2b3…', 'landing_viewed', 'simplevetcare.com', 'VETCARE', 'unknown', '—', 'desktop', 'chrome', '—', '—', 'build_7d1'],
  ['Nov 09, 13:59:41', '8df84db2-2b3…', 'gate_viewed', 'simplevetcare.com', 'VETCARE', 'unknown', '—', 'desktop', 'chrome', '—', 'redirect_timeout', 'build_7d1'],
  ['Nov 09, 13:58:25', 'a802f2a1-c8f…', 'landing_viewed', 'lendingbaddies.com', 'LENDING', 'unknown', '—', 'desktop', 'unknown', '—', '—', 'unknown'],
  ['Nov 09, 13:58:19', 'a802f2a1-c8f…', 'form_started', 'lendingbaddies.com', 'LENDING', 'unknown', '—', 'desktop', 'unknown', '—', '—', 'unknown'],
  ['Nov 09, 13:57:55', '5c41a2e3-c6f…', 'landing_viewed', 'skratchpayoptions.com', 'SKRATCH', 'unknown', '—', 'desktop', 'chrome', '—', '—', 'build_4d9'],
  ['Nov 09, 13:57:33', '75be2d18-a7e…', 'lead_submitted', 'deercreeklending.com', 'DEERCREEK', 'unknown', '—', 'mobile', 'chrome', '4', '—', 'build_5e3']
] as const
