import type { LifecycleBrandSummary, TemplateVersionSummary } from "@anjuna/contracts";
import { isDemoBrand, matchesBrandChip, type BrandChip, type BrandHealth } from "./brand-health";
import { inScope, toScopeBrand, type BrandScope } from "./brand-scope";
import { checklistFlags } from "./home-metrics";

/**
 * One predicate per to-do count. The Home cards, the /brands and /templates filters they open, and GET /api/nav/counts all call
 * these, so a number and the rows it opens are computed by the same code. No React here: the Worker imports this file too.
 */

/** One brand's entry of the batch checklist read. Undefined when the batch does not list the brand or the read failed. */
export type ChecklistEntry = Parameters<typeof checklistFlags>[0];

/** A live, non-demo brand whose checklist has no test_sold row. An unknown or missing checklist never counts. */
export function needsTestSold(brand: LifecycleBrandSummary, checklist: ChecklistEntry): boolean {
  return brand.status === "live" && !isDemoBrand(brand) && checklistFlags(checklist).test_sold === false;
}

/** A live, non-demo brand whose checklist has no drain_route row. An unknown or missing checklist never counts. */
export function needsDrainRoute(brand: LifecycleBrandSummary, checklist: ChecklistEntry): boolean {
  return brand.status === "live" && !isDemoBrand(brand) && checklistFlags(checklist).drain_route === false;
}

/** A brand saved from the wizard but never generated. */
export function isDraft(brand: Pick<LifecycleBrandSummary, "status">): boolean {
  return brand.status === "draft";
}

/** A certified version of a template that is not archived: the Owner still has to approve it. */
export function awaitingApproval(version: Pick<TemplateVersionSummary, "status" | "archived">): boolean {
  return !version.archived && version.status === "awaiting_approval";
}

/**
 * Whether the /brands list shows a brand under a scope: the brand ticks, the demo box, and paused or retired brands hidden while
 * hideInactive is on. The หยุด chip passes hideInactive false, since it exists to show them. runtimeStatus is core's status, when read.
 */
export function listedInBrands(scope: BrandScope, brand: LifecycleBrandSummary, runtimeStatus: string | undefined, hideInactive = scope.hideInactive): boolean {
  return inScope({ ...scope, hideInactive }, toScopeBrand(brand, runtimeStatus));
}

/** Every chip of the /brands list. The task chips read the brand's checklist; the others read its health. */
export function matchesListChip(chip: BrandChip, health: BrandHealth, brand: LifecycleBrandSummary, checklist: ChecklistEntry): boolean {
  switch (chip) {
    case "test-sold": return needsTestSold(brand, checklist);
    case "drain-route": return needsDrainRoute(brand, checklist);
    case "drafts": return isDraft(brand);
    default: return matchesBrandChip(health, brand, chip);
  }
}

/**
 * The scope test for a brand id, like the brand scope hook: a brand on the list follows the full scope, an id the list does not hold
 * (a report row of a brand the lists missed) follows the brand ticks only.
 */
export function scopeTest(scope: BrandScope, brands: readonly LifecycleBrandSummary[], runtimeStatus: (brandId: string) => string | undefined): (brandId: string) => boolean {
  const byId = new Map(brands.map((brand) => [brand.brand_id, brand] as const));
  return (brandId) => {
    const brand = byId.get(brandId);
    return brand ? listedInBrands(scope, brand, runtimeStatus(brandId)) : scope.brandIds === null || scope.brandIds.includes(brandId);
  };
}
