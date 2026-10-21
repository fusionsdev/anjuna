/**
 * Checklist item `drain_route`, computed from core. Core serves the brand's Google Ads route to the
 * VPS drain (GET /api/conversions/routing), so a brand whose account and conversion action are both
 * set is routed without anyone attesting it. Nothing is written to D1: the row is rebuilt per read.
 */
import { ChecklistEvidence, type BrandConfig } from "@anjuna/contracts";

/** The computed row, or null when the route is incomplete. */
export function drainRouteRow(brand: BrandConfig): Record<string, unknown> | null {
  if (!brand.google_ads_account || !brand.google_conversion_action) return null;
  const evidence = ChecklistEvidence.safeParse({
    brand_id: brand.brand_id, item: "drain_route", actor_id: "system", verified_at: brand.updated_at,
  });
  if (!evidence.success) return null;
  return { item: "drain_route", evidence: evidence.data, confirmed_by: "system", confirmed_role: "system", confirmed_at: brand.updated_at };
}
