/** Shared D1 seed helpers: insert minimal valid rows into the `leads` schema. */

export const NOW = "2026-10-02T00:00:00.000Z";

export interface LeadSeed {
  lead_id: string;
  brand: string;
  variant: string | null;
  keyword: string | null;
  created_at: string;
}

/** Insert a full lead (all V1 NOT NULL columns) plus Anjuna attribution columns. */
export function insertLead(db: D1Database, seed: LeadSeed) {
  return db
    .prepare(
      `INSERT INTO leads (lead_id, session_id, form_version, form_variant, site_id, brand, hostname,
        requested_amount, loan_purpose, first_name, last_name, birth_date, email, home_phone, address,
        city, state, zip, address_length_months, own_home, income_type, employer, job_title,
        employed_months, pay_date1, pay_frequency, direct_deposit, monthly_income, tracking_json,
        metadata_json, created_at, variant, keyword)
       VALUES (?1, ?2, 'v1', 'lite_v1', 'site', ?3, ?4, 500, 'bills', 'Ann', 'Lee',
        '1990-01-01', ?5, '5555550100', '1 Main St', 'Austin', 'TX', '73301', 12, 0,
        'EMPLOYMENT', 'Acme', 'Clerk', 24, '2026-10-09', 'BIWEEKLY', 1, 3000, '{}', '{}',
        ?6, ?7, ?8)`,
    )
    .bind(
      seed.lead_id,
      `s_${seed.lead_id}`,
      seed.brand,
      `${seed.brand}.test`,
      `${seed.lead_id}@example.test`,
      seed.created_at,
      seed.variant,
      seed.keyword,
    );
}

export interface ClickSeed {
  id: string;
  hostname: string;
  variant: string | null;
  keyword: string | null;
  seen_at: string;
}

export function insertClick(db: D1Database, seed: ClickSeed) {
  return db
    .prepare(
      `INSERT INTO click_sessions (click_session_id, click_seen_at, first_seen_at, last_seen_at, created_at, hostname, variant, keyword)
       VALUES (?1, ?2, ?2, ?2, ?2, ?3, ?4, ?5)`,
    )
    .bind(seed.id, seed.seen_at, seed.hostname, seed.variant, seed.keyword);
}

export interface PostbackSeed {
  lead_id: string;
  event_type: string;
  payout: number;
  created_at: string;
}

export function insertPostback(db: D1Database, seed: PostbackSeed) {
  return db
    .prepare(`INSERT INTO postback_events (lead_id, event_type, payout, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(seed.lead_id, seed.event_type, seed.payout, seed.created_at);
}

export interface ConversionSeed {
  lead_id: string;
  status: string;
  occurred_at: string;
  created_at: string;
}

export function insertConversion(db: D1Database, seed: ConversionSeed) {
  return db
    .prepare(`INSERT INTO conversion_uploads (lead_id, status, occurred_at, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(seed.lead_id, seed.status, seed.occurred_at, seed.created_at);
}

export function insertBrandRuntime(db: D1Database, brand_id: string, hostnames: string[], at = NOW) {
  return db
    .prepare(
      `INSERT INTO brand_runtime (brand_id, account, hostnames, drain_key, aid, prepop_base, created_at, updated_at)
       VALUES (?1, 'owner', ?2, ?1, '12345', 'https://prepop.invalid/form', ?3, ?3)`,
    )
    .bind(brand_id, JSON.stringify(hostnames), at);
}

/** Delete every row (children first) so each test starts from a clean leads D1. */
export async function truncateLeads(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM conversion_uploads"),
    db.prepare("DELETE FROM postback_events"),
    db.prepare("DELETE FROM mailing_outbox"),
    db.prepare("DELETE FROM leads"),
    db.prepare("DELETE FROM click_sessions"),
  ]);
}