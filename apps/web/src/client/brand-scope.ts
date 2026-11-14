import type { LifecycleBrandSummary } from "@anjuna/contracts";
import { brandHealth, isDemoBrand } from "./brand-health";

/**
 * Which brands every page shows. Saved per user through GET/PUT /api/me/prefs (`brand_scope`), so phone and desktop agree.
 * brandIds null means every brand. The default hides paused, retired and demo brands.
 */
export interface BrandScope { hideInactive: boolean; showDemo: boolean; brandIds: string[] | null }

export const DEFAULT_SCOPE: BrandScope = { hideInactive: true, showDemo: false, brandIds: null };

/** The wire shape of `UserPrefs.brand_scope` (packages/contracts, lane W01). */
export interface BrandScopePrefs { hide_inactive: boolean; show_demo: boolean; brand_ids: string[] | null }

export const scopeFromPrefs = (prefs: BrandScopePrefs): BrandScope => ({ hideInactive: prefs.hide_inactive, showDemo: prefs.show_demo, brandIds: prefs.brand_ids });
export const scopeToPrefs = (scope: BrandScope): BrandScopePrefs => ({ hide_inactive: scope.hideInactive, show_demo: scope.showDemo, brand_ids: scope.brandIds });

/**
 * `?scope=` overrides the saved scope for one visit, so a link can carry a view.
 * `all` shows every brand, `active` is the default, anything else is a comma list of brand ids.
 */
export function scopeFromSearch(search: string): BrandScope | null {
  const value = new URLSearchParams(search).get("scope");
  if (value === null || value === "") return null;
  if (value === "all") return { hideInactive: false, showDemo: true, brandIds: null };
  if (value === "active") return DEFAULT_SCOPE;
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  return ids.length ? { hideInactive: false, showDemo: true, brandIds: ids } : null;
}

/** The `?scope=` value scopeFromSearch reads back as `scope`. Null for a scope no link can carry (a saved mix of ticks). */
export function scopeToSearch(scope: BrandScope): string | null {
  if (scope.brandIds !== null) return scope.brandIds.length && !scope.hideInactive && scope.showDemo ? scope.brandIds.join(",") : null;
  if (!scope.hideInactive && scope.showDemo) return "all";
  if (scope.hideInactive && !scope.showDemo) return "active";
  return null;
}

/** What the scope needs to know about one brand. `inactive` is paused or retired. */
export interface ScopeBrand { id: string; demo: boolean; inactive: boolean }

export function inScope(scope: BrandScope, brand: ScopeBrand): boolean {
  if (scope.brandIds && !scope.brandIds.includes(brand.id)) return false;
  if (!scope.showDemo && brand.demo) return false;
  if (scope.hideInactive && brand.inactive) return false;
  return true;
}

export type ScopeGroup = "active" | "fix" | "unfinished" | "paused" | "retired" | "demo";

export const SCOPE_GROUPS: ReadonlyArray<{ id: ScopeGroup; label: string }> = [
  { id: "active", label: "ใช้งาน" },
  { id: "fix", label: "ต้องแก้" },
  { id: "unfinished", label: "ยังไม่เสร็จ" },
  { id: "paused", label: "หยุด" },
  { id: "retired", label: "เลิกใช้แล้ว" },
  { id: "demo", label: "ทดลอง" },
];

/** Paused: the factory status, or the runtime status when the runtime read answered. */
export function isInactive(brand: LifecycleBrandSummary, runtimeStatus?: string): boolean {
  return brand.status === "retired" || brand.status === "paused" || runtimeStatus === "paused";
}

export function toScopeBrand(brand: LifecycleBrandSummary, runtimeStatus?: string): ScopeBrand {
  return { id: brand.brand_id, demo: isDemoBrand(brand), inactive: isInactive(brand, runtimeStatus) };
}

export function groupOfBrand(brand: LifecycleBrandSummary, runtimeStatus?: string): ScopeGroup {
  if (isDemoBrand(brand)) return "demo";
  if (brand.status === "retired") return "retired";
  if (isInactive(brand, runtimeStatus)) return "paused";
  const health = brandHealth(brand, undefined);
  // A draft has no domain yet, so it is unfinished before it is broken.
  if (brand.status === "draft" || health.issues.includes("install_running")) return "unfinished";
  if (health.issues.some((issue) => issue === "install_failed" || issue === "sync_error" || issue === "no_domain")) return "fix";
  return "active";
}

/** The chip under a page title: "แสดง n จาก m แบรนด์ · ซ่อนที่ไม่ได้ใช้ k". */
export function scopeSummary(visible: number, total: number): string {
  return `แสดง ${visible} จาก ${total} แบรนด์ · ซ่อนที่ไม่ได้ใช้ ${total - visible}`;
}
