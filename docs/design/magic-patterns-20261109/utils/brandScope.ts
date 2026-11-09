import { brands } from '../data/brands'
import type { Brand, BrandScope } from '../types/app'

export const defaultBrandScope: BrandScope = {
  selectedIds: brands.map((brand) => brand.id),
  hideUnused: true,
  showTest: false
}

export function isBrandInScope(brand: Brand, scope: BrandScope): boolean {
  if (!scope.selectedIds.includes(brand.id)) return false
  if (!scope.showTest && brand.isTest) return false
  if (scope.hideUnused && (brand.state === 'paused' || brand.state === 'retired')) return false
  return true
}

export function brandIdFor(value: string): string | undefined {
  const normalized = value.toLowerCase()
  const aliases: Record<string, string> = {
    aurum: 'petplanloans', skratch: 'petvetpay', vetcare: 'cedarline', lending: 'willow', deercreek: 'ridgeway'
  }
  return brands.find((brand) => brand.id === normalized || brand.name.toLowerCase() === normalized || brand.domain.toLowerCase() === normalized)?.id ?? aliases[normalized]
}

export function isDisplayBrandInScope(value: string, scope: BrandScope): boolean {
  const id = brandIdFor(value)
  return id ? isBrandInScope(brands.find((brand) => brand.id === id) as Brand, scope) : true
}

export function scopeSummary(scope: BrandScope): string {
  const visible = brands.filter((brand) => isBrandInScope(brand, scope)).length
  const hidden = brands.length - visible
  return `แสดง ${visible} จาก ${brands.length} แบรนด์ · ซ่อนที่ไม่ได้ใช้ ${hidden}`
}
