/**
 * campaign_brand_map writer for panel-created campaigns (T13 Part A1, `source = 'create'`, table from migration 0022).
 *
 * The panel made the campaign for this brand, so the row is known: it replaces a 'click' row or an older 'create'
 * row. It never replaces a 'manual' row, because the owner's assignment wins (spend-allocation.ts follows the
 * same order: manual over create over click).
 */
export interface CampaignBrandRow { account: string; campaign_id: string; brand_id: string }

export type RecordCampaignBrand = (db: D1Database, row: CampaignBrandRow) => Promise<void>;

export const recordCampaignBrand: RecordCampaignBrand = async (db, row) => {
  const at = new Date().toISOString();
  await db.prepare(`
    INSERT INTO campaign_brand_map (account, campaign_id, brand_id, source, first_seen, updated_at)
    VALUES (?1, ?2, ?3, 'create', ?4, ?4)
    ON CONFLICT (account, campaign_id) DO UPDATE SET brand_id = excluded.brand_id, source = 'create', updated_at = excluded.updated_at
    WHERE campaign_brand_map.source <> 'manual'`)
    .bind(row.account, row.campaign_id, row.brand_id, at).run();
};
