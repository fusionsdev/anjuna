import { BUYER_FIELDS, SUBMIT_CONTEXT_HEADERS, type SubmitLeadRequest } from "@anjuna/contracts";
import { sha256 } from "../auth.js";
import type { Env } from "../env.js";
import { json } from "../http.js";
import { consentText } from "./consent.js";
import { continuation, type Applicant } from "./continuations.js";
import { validateLeadPayload, type ValidationEnv, type ValidLead } from "./validation.js";

export function validationEnv(env: Env): ValidationEnv {
  return { FORM_SITE_ID: env.FORM_SITE_ID ?? "form-default", FORM_VERSION: env.FORM_VERSION ?? "2026-01",
    CONSENT_VERSION: env.CONSENT_VERSION ?? "consent-2026-02", PARTNER_LIST_VERSION: env.PARTNER_LIST_VERSION ?? "partners-2026-01" };
}
const invalid = (message: string, status = 400) => json({ status: "invalid", message }, status);
const CLICK_KEYS = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid", "external_click_id", "aid"] as const;
const unsetOr = (value: string) => value === "" ? -1 : Number(value);

async function duplicate(env: Env, lead: ValidLead, brandId: string): Promise<Response | null> {
  const existing = await env.LEADS.prepare("SELECT brand FROM leads WHERE lead_id = ?1").bind(lead.lead_id).first<{ brand: string }>();
  if (!existing) return null;
  // A client cannot reuse another brand's identifier to mint a continuation for its PII.
  if (existing.brand !== brandId) return invalid("Invalid identifiers");
  // V1 duplicate branch: hand off the current validated applicant, never the stored one.
  const applicant = Object.fromEntries(BUYER_FIELDS.map((key) => [key, lead.fields[key]])) as Applicant;
  const next = await continuation(env, lead.lead_id, brandId, applicant);
  await next.statement.run();
  return json({ status: "duplicate", lead_id: lead.lead_id, reference: lead.lead_id.slice(-8), continuation: next.token });
}

export async function submitLead(input: SubmitLeadRequest, request: Request, env: Env): Promise<Response> {
  const result = validateLeadPayload(input.lead, validationEnv(env));
  if (!result.ok) return invalid(result.message);
  const lead = result.value;
  let consentBrand: string;
  try { consentBrand = decodeURIComponent(request.headers.get(SUBMIT_CONTEXT_HEADERS.consent_brand) ?? ""); }
  catch { return invalid("Invalid consent context"); }
  if (!consentBrand.trim() || consentBrand.length > 80 || /[\r\n]/.test(consentBrand)) return invalid("Invalid consent context");
  const f = lead.fields;
  const state = await env.LEADS.prepare("SELECT state FROM zip_lookup WHERE zip = ?1 LIMIT 1")
    .bind(f.zip).first<{ state: string }>();
  f.state = state?.state?.toUpperCase() ?? "";
  const repeat = await duplicate(env, lead, input.brand_id);
  if (repeat) return repeat;
  const clickId = lead.lead_id.replace(/-/g, "");
  lead.tracking.click_id = clickId;
  lead.tracking.clickid = clickId;
  const now = new Date().toISOString();
  const session = input.click_session_id ? await env.LEADS.prepare(`SELECT * FROM click_sessions
    WHERE click_session_id = ?1 AND brand_id = ?2 AND lead_id IS NULL`)
    .bind(input.click_session_id, input.brand_id).first<Record<string, string | null>>() : null;
  const tracking = { ...lead.tracking };
  if (session) for (const key of CLICK_KEYS) {
    const value = session[key]?.trim();
    if (value) tracking[key] = value;
  }
  const next = await continuation(env, lead.lead_id, input.brand_id);
  const gpc = request.headers.get(SUBMIT_CONTEXT_HEADERS.gpc);
  const textHash = await sha256(consentText(consentBrand));
  const ipHash = await sha256(`${input.client.ip}:${lead.site.site_id}`);
  const claims: D1PreparedStatement[] = [];
  if (session) claims.push(env.LEADS.prepare(`UPDATE click_sessions SET lead_id = ?1, last_seen_at = ?2
    WHERE click_session_id = ?3 AND brand_id = ?4 AND lead_id IS NULL`).bind(lead.lead_id, now, input.click_session_id, input.brand_id));

  // The claim, lead, evidence, continuation and outbox commit together. The INSERT reads the
  // claim inside this batch: only the winner of concurrent claims receives server attribution.
  const claimed = "EXISTS (SELECT 1 FROM click_sessions WHERE click_session_id = ?1 AND brand_id = ?2 AND lead_id = ?3)";
  const leadInsert = env.LEADS.prepare(`INSERT INTO leads (
    lead_id, session_id, form_version, form_variant, site_id, brand, hostname,
    requested_amount, loan_purpose, first_name, last_name, birth_date, email, home_phone, work_phone,
    address, city, state, zip, address_length_months, own_home, income_type, employer, job_title,
    employed_months, pay_date1, pay_frequency, direct_deposit, monthly_income,
    tracking_json, metadata_json, status, created_at, click_id, experiment_id, variant, keyword)
    VALUES (?3, ?4, ?5, ?6, ?7, ?2, ?8,
      ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
      ?26, ?27, ?28, ?29, ?30,
      CASE WHEN ${claimed} THEN ?31 ELSE ?32 END, ?33, ?34, ?35, ?36,
      CASE WHEN ${claimed} THEN ?37 ELSE ?38 END,
      CASE WHEN ${claimed} THEN ?39 ELSE ?40 END,
      CASE WHEN ${claimed} THEN ?41 ELSE ?42 END)`)
    .bind(input.click_session_id, input.brand_id, lead.lead_id, lead.session_id, lead.form_version,
      lead.form_variant, lead.site.site_id, input.hostname,
      Number(f.requested_amount), f.loan_purpose, f.first_name, f.last_name, f.birth_date, f.email, f.home_phone,
      f.work_phone || null, f.address, f.city, f.state, f.zip, unsetOr(f.address_length_months), unsetOr(f.own_home),
      f.income_type, f.employer, f.job_title, unsetOr(f.employed_months), f.pay_date1, f.pay_frequency,
      unsetOr(f.direct_deposit), unsetOr(f.monthly_income), JSON.stringify(tracking), JSON.stringify(lead.tracking),
      JSON.stringify({ ...lead.metadata, hostname: input.hostname }), "accepted",
      now, clickId, session?.experiment_id ?? input.experiment_id ?? null, input.experiment_id ?? null,
      session?.variant ?? input.variant ?? lead.form_variant.toLowerCase(), input.variant ?? lead.form_variant.toLowerCase(),
      session?.keyword ?? lead.tracking.keyword ?? null, lead.tracking.keyword ?? null);
  try {
    await env.LEADS.batch([
      ...claims, leadInsert,
      env.LEADS.prepare(`INSERT INTO consent_evidence (lead_id, application_consent, consent_version,
        partner_list_version, accepted_at, page_url, hostname, ip_hash, user_agent, form_version,
        created_at, consent_text_hash, consent_brand, gpc)
        VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
        .bind(lead.lead_id, lead.consent.consent_version, lead.consent.partner_list_version,
          lead.consent.accepted_at, lead.consent.page_url, input.hostname, ipHash, input.client.user_agent.slice(0, 512),
          lead.form_version, now, textHash, consentBrand, gpc === "1" ? 1 : gpc === "0" ? 0 : null),
      next.statement,
      env.LEADS.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES (?1, ?2, ?3)")
        .bind(lead.lead_id, input.brand_id, now),
    ]);
  } catch (error) {
    // Concurrent submissions of the same client id retain the V1 duplicate response.
    const raced = await duplicate(env, lead, input.brand_id);
    if (raced) return raced;
    throw error;
  }
  return json({ status: "accepted", lead_id: lead.lead_id, reference: lead.lead_id.slice(-8), continuation: next.token }, 201);
}
