/**
 * Computed checklist items. `drain_route`, computed from core. Core serves the brand's Google Ads route to the
 * VPS drain (GET /api/conversions/routing), so a brand whose account and conversion action are both
 * set is routed without anyone attesting it. Nothing is written to D1: the row is rebuilt per read.
 */
import { ChecklistEvidence, type BrandConfig } from "@anjuna/contracts";
import { compensatedInstallSql } from "@anjuna/factory-db";

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

type SmokeRow = { brand_id: string; status: string; created_at: string };

/**
 * The newest judging smoke receipt per brand, in one statement. `brandId` limits it to one brand; null covers every live brand.
 * Run it alone (smokeFinalUrlRow) or inside one D1 batch with the other reads of the batch checklist.
 */
export function smokeFinalUrlStatement(db: D1Database, brandId: string | null): D1PreparedStatement {
  const scope = brandId === null ? "i.brand_id IN (SELECT brand_id FROM brands WHERE status = 'live')" : "i.brand_id = ?1";
  const statement = db.prepare(`SELECT brand_id, status, created_at FROM (
    SELECT i.brand_id AS brand_id, r.status AS status, r.created_at AS created_at,
      ROW_NUMBER() OVER (PARTITION BY i.brand_id ORDER BY r.created_at DESC, r.id DESC) AS rn
    FROM install_receipts r JOIN installs i ON i.install_id = r.install_id
    WHERE ${scope} AND r.step = 'smoke' AND NOT ${compensatedInstallSql("i.install_id")}
      AND (r.status = 'failed' OR (CASE WHEN json_valid(r.output_json) THEN json_extract(r.output_json, '$.final_url') IS NOT NULL ELSE 0 END))
  ) WHERE rn = 1`);
  return brandId === null ? statement : statement.bind(brandId);
}

/** The computed rows for the statement's results, keyed by brand id. A brand whose newest judging smoke failed has no row. */
export function smokeFinalUrlRows(results: SmokeRow[]): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of results) {
    if (row.status !== "ok") continue;
    const evidence = ChecklistEvidence.safeParse({ brand_id: row.brand_id, item: "final_url", actor_id: SMOKE_ACTOR, verified_at: row.created_at });
    if (!evidence.success) continue;
    rows.set(row.brand_id, { item: "final_url", evidence: evidence.data, confirmed_by: SMOKE_ACTOR, confirmed_role: "system", confirmed_at: row.created_at });
  }
  return rows;
}

/**
 * Checklist item `final_url`, computed from the install smoke step: the newest smoke receipt of the brand that judged the
 * live landing page (a passed one records `final_url`; a smoke of a paused brand records none and is skipped). Ticked only
 * when that receipt passed. Smokes of compensated installs are skipped: the compensation removed the page they judged,
 * so the newest remaining smoke decides, and with none left the row is null. Nothing is written to D1.
 */
export async function smokeFinalUrlRow(db: D1Database, brandId: string): Promise<Record<string, unknown> | null> {
  const { results } = await smokeFinalUrlStatement(db, brandId).all<SmokeRow>();
  return smokeFinalUrlRows(results).get(brandId) ?? null;
}

/** The four steps of the brand checklist panel, in the order of the plan. */
export const CHECKLIST_STEP_ITEMS = ["final_url", "leadsgate_postbacks", "test_sold", "drain_route"] as const;
export type ChecklistStepRow = { item: (typeof CHECKLIST_STEP_ITEMS)[number]; done: boolean; evidence: string | null };

/** " · event <id>" when the evidence carries an event id (a verified Test sold does), else nothing. */
function eventSuffix(evidence: unknown): string {
  const id = (evidence as { event_id?: unknown } | null)?.event_id;
  return typeof id === "string" && id !== "" ? ` · event ${id}` : "";
}

/**
 * Exactly four rows, one per checklist item, finished or not. `evidence` is a short text (who confirmed it and when) for a finished
 * step and null for an open one. The `checklist` rows stay the source of truth; this is the same data in the shape the panel draws.
 */
export function checklistSteps(rows: Array<Record<string, unknown>>): ChecklistStepRow[] {
  return CHECKLIST_STEP_ITEMS.map((item) => {
    const row = rows.find((r) => r.item === item);
    return row
      ? { item, done: true, evidence: `${String(row.confirmed_by)} · ${String(row.confirmed_at)}${eventSuffix(row.evidence)}` }
      : { item, done: false, evidence: null };
  });
}
