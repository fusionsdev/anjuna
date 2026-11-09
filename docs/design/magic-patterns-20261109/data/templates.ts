import type { Category, Template } from '../types/app'

export const categories: Category[] = [
  { id: 'all', label: 'ทั้งหมด', count: 24 },
  { id: 'personal', label: 'สินเชื่อส่วนบุคคล', count: 9 },
  { id: 'pets', label: 'สัตว์เลี้ยง', count: 7 },
  { id: 'smallbiz', label: 'ธุรกิจขนาดเล็ก', count: 5 },
  { id: 'uncategorized', label: 'ยังไม่จัดหมวด', count: 3 },
  { id: 'archived', label: 'เก็บถาวร', count: 2 }
]

export const statusFilters = [
  { id: 'pending', label: 'รออนุมัติ', count: 4 },
  { id: 'approved', label: 'อนุมัติแล้ว', count: 15 },
  { id: 'draft', label: 'ร่าง', count: 5 }
] as const

export const templates: Template[] = [
  { id: 't1', name: 'Pet Loan Hero', slug: 'pet-loan-hero', category: 'pets', status: 'approved', version: 5, brands: 3, updated: '4 พ.ย.', color: '#F83808' },
  { id: 't2', name: 'Quick Cash Split', slug: 'quick-cash-split', category: 'personal', status: 'pending', version: 2, brands: 0, updated: 'วันนี้ 09:14', color: '#2F5DA8' },
  { id: 't3', name: 'Vet Bill Helper', slug: 'vet-bill-helper', category: 'pets', status: 'pending', version: 1, brands: 0, updated: 'เมื่อวาน', color: '#0E7A4F' },
  { id: 't4', name: 'Small Biz Funding Long', slug: 'smallbiz-funding-long', category: 'smallbiz', status: 'approved', version: 4, brands: 5, updated: '30 ต.ค.', color: '#111111' },
  { id: 't5', name: 'Payday Compare', slug: 'payday-compare', category: 'personal', status: 'approved', version: 3, brands: 7, updated: '27 ต.ค.', color: '#9A5B07' },
  { id: 't6', name: 'Credit Rebuild Quiz', slug: 'credit-rebuild-quiz', category: 'personal', status: 'pending', version: 1, brands: 0, updated: 'วันนี้ 08:02', color: '#C42A03' },
  { id: 't7', name: 'Merchant Advance', slug: 'merchant-advance', category: 'smallbiz', status: 'draft', version: 1, brands: 0, updated: '2 พ.ย.', color: '#6B6B70' },
  { id: 't8', name: 'อัปโหลด 0412', slug: 'upload-0412', category: 'uncategorized', status: 'pending', version: 1, brands: 0, updated: 'วันนี้ 10:20', color: '#2F5DA8' },
  { id: 't9', name: 'Pet Insurance Lite', slug: 'pet-insurance-lite', category: 'pets', status: 'draft', version: 2, brands: 0, updated: '1 พ.ย.', color: '#0E7A4F' },
  { id: 't10', name: 'Old Payday 2025', slug: 'old-payday-2025', category: 'archived', status: 'approved', version: 6, brands: 0, updated: '12 ก.ย.', color: '#6B6B70' }
]
