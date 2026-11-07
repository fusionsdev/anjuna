/**
 * campaign_brand_map writer for panel-created campaigns (T13 Part A1, `source = 'create'`).
 *
 * The table arrives with T13-1 (leads-db migration 0022, PR 181), which is not on main yet. Until it merges this
 * function does nothing, so a done campaign.draft.create job records no map row and its spend falls to the
 * click-based mapping or the estimate.
 *
 * After T13-1 merges: replace the no-op body with
 *   INSERT INTO campaign_brand_map (account, campaign_id, brand_id, source, first_seen, updated_at)
 *   VALUES (?1, ?2, ?3, 'create', ?4, ?4)
 *   ON CONFLICT (account, campaign_id) DO UPDATE SET brand_id = excluded.brand_id, source = 'create', updated_at = excluded.updated_at
 * ('create' is known, so it may overwrite a 'click' row; check T13-1's rule for 'manual' before overwriting one).
 */
export interface CampaignBrandRow { account: string; campaign_id: string; brand_id: string }

export type RecordCampaignBrand = (db: D1Database, row: CampaignBrandRow) => Promise<void>;

export const recordCampaignBrand: RecordCampaignBrand = async () => {};
