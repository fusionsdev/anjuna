export type PageId =
  | 'home'
  | 'brands'
  | 'templates'
  | 'campaigns'
  | 'traffic'
  | 'leads'
  | 'alerts'
  | 'adkit'
  | 'settings'
  | 'new-brand'

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent'

export type StageStatus = 'done' | 'warn' | 'fail' | 'pending'

export type BrandState = 'fix' | 'active' | 'incomplete' | 'paused' | 'retired'

export interface BrandScope {
  selectedIds: string[]
  hideUnused: boolean
  showTest: boolean
}

export type StepStatus = 'ok' | 'fail' | 'pending'

export interface ChecklistStep {
  label: string
  status: StepStatus
  detail: string
  fixLabel?: string
}

export interface Brand {
  id: string
  name: string
  domain: string
  stages: StageStatus[]
  spend: number | null
  leads: number | null
  cpl: number | null
  ads: { label: string; tone: Tone }
  action: { label: string; primary: boolean }
  state: BrandState
  isTest?: boolean
  checklist: ChecklistStep[]
  adkit: { spend: number | null; leads: number | null; failedUploads: number | null; updated: string }
}

export type TemplateStatus = 'pending' | 'approved' | 'draft'

export interface Template {
  id: string
  name: string
  slug: string
  category: string
  status: TemplateStatus
  version: number
  brands: number
  updated: string
  color: string
}

export interface Category {
  id: string
  label: string
  count: number
}
