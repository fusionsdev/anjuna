export const wizardSteps = ['ข้อมูลแบรนด์', 'เทมเพลต', 'โดเมน', 'ติดตามผลและ Google Ads', 'ตรวจและสร้าง']

export const adkitProjects = [
  { id: 'p1', label: 'Pet Lending TH · prj_8f21' },
  { id: 'p2', label: 'Personal Loans TH · prj_3c90' },
  { id: 'p3', label: 'Small Business TH · prj_71ad' }
]

export const adsAccounts = [
  { id: 'a1', label: '482-193-6650 · Anjuna Pet TH', currency: 'THB' },
  { id: 'a2', label: '317-552-0841 · Anjuna Lending TH', currency: 'THB' }
]

export const existingActions = [
  { id: 'cv-1', label: 'cv-71b2e0c9 · Lead sold (PetPlanLoans)' },
  { id: 'cv-2', label: 'cv-0d4a19ff · Lead sold (Ridgeway Pet Care)' }
]

export const apiEndpoints = [
  'POST /v1/brands',
  'POST /v1/brands/{id}/template',
  'POST /v1/brands/{id}/domain',
  'POST /v1/adkit/conversion-actions',
  'POST /v1/brands/{id}/deploy'
]
