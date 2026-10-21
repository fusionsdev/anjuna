/**
 * Computed checklist items. `drain_route`, computed from core. Core serves the brand's Google Ads route to the
 * VPS drain (GET /api/conversions/routing), so a brand whose account and conversion action are both
 * set is routed without anyone attesting it. Nothing is written to D1: the row is rebuilt per read.
 */
import { ChecklistEvidence, type BrandConfig } from "@anjuna/contracts";

const SMOKE_ACTOR = "system:smoke";

/** The computed row, or null when the route is incomplete. */
export function drainRouteRow(brand: BrandConfig): Record<string, unknown> | null {
  if (!brand.google_ads_account || !brand.google_conversion_action) return null;
  const evidence = ChecklistEvidence.safeParse({
    brand_id: brand.brand_id, item: "drain_route", actor_id: "system", verified_at: brand.updated_at,
  });
  if (!evidence.success) return null;
  return { item: "drain_route", evidence: evidence.data, confirmed_by: "system", confirmed_role: "system", confirmed_at: brand.updated_at };
}

/**
 * Checklist item `final_url`, computed from the install smoke step: the newest smoke receipt of the brand that judged the
 * live landing page (a passed one records `final_url`; a smoke of a paused brand records none and is skipped). Ticked only
 * when that receipt passed. Nothing is written to D1.
 */
export async function smokeFinalUrlRow(db: D1Database, brandId: string): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(`SELECT r.status, r.created_at FROM install_receipts r JOIN installs i ON i.install_id = r.install_id
    WHERE i.brand_id = ?1 AND r.step = 'smoke'
      AND (r.status = 'failed' OR (CASE WHEN json_valid(r.output_json) THEN json_extract(r.output_json, '$.final_url') IS NOT NULL ELSE 0 END))
    ORDER BY r.created_at DESC, r.id DESC LIMIT 1`).bind(brandId).first<{ status: string; created_at: string }>();
  if (row?.status !== "ok") return null;
  const evidence = ChecklistEvidence.safeParse({ brand_id: brandId, item: "final_url", actor_id: SMOKE_ACTOR, verified_at: row.created_at });
  if (!evidence.success) return null;
  return { item: "final_url", evidence: evidence.data, confirmed_by: SMOKE_ACTOR, confirmed_role: "system", confirmed_at: row.created_at };
}
