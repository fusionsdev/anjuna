// @ts-nocheck -- verbatim V1 code predates this repo's noUncheckedIndexedAccess; checked by tests instead.
// VERBATIM EXCERPT of V1 `functions/api/[[path]].ts` (fusionsdev/fusion_formv_v1@8404ec2).
// Only pure code is copied, unchanged, so golden tests can run the real V1 validator and the
// real V1 prepop redirect builder against the contract fixtures. Do not edit the excerpted
// lines; re-copy them instead. The Env interface and the export lines are the only additions.
// Line ranges: 98-103, 118-124, 145-158, 1044-1088, 1187-1384, 1431-1444, 1501-1548.
// `test/v1-source.test.ts` re-checks every range against a V1 checkout when V1_DIR is set.

export interface Env {
  FORM_SITE_ID: string;
  FORM_VERSION: string;
  CONSENT_VERSION: string;
  PARTNER_LIST_VERSION: string;
  BUYER_MODE?: string;
  LEADSGATE_PREPOP_URL?: string;
  ALLOWED_AIDS?: string;
}

const TRACKING_KEYS = [
  "clickid", "click_id", "gclid", "gbraid", "wbraid", "msclkid", "fbclid",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "campaign_id", "adgroup_id", "ad_id", "keyword",
  "sub1", "sub2", "sub3", "sub4", "sub5",
] as const;
const LOAN_PURPOSES = new Set([
  "DEBT_CONSOLIDATION", "EMERGENCY_SITUATION", "CREDIT_CARD_CONSOLIDATION",
  "AUTO_PURCHASE", "HOME_IMPROVEMENT", "MEDICAL", "BUSINESS", "TAXES",
  "RENT_OR_MORTGAGE", "OTHER",
]);
const INCOME_TYPES = new Set(["EMPLOYMENT", "BENEFITS", "SELF_EMPLOYED", "MILITARY"]);
const PAY_FREQUENCIES = new Set(["WEEKLY", "BIWEEKLY", "TWICEMONTHLY", "MONTHLY"]);
const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

// The exact LeadsGate GET-param names the buyer expects (from Pre-pop instruction).
const BUYER_FIELDS = [
  "requested_amount", "loan_purpose", "first_name", "last_name", "birth_date",
  "email", "home_phone", "work_phone", "address", "city", "state", "zip",
  "address_length_months", "own_home", "income_type", "employer", "job_title",
  "employed_months", "pay_date1", "pay_frequency", "direct_deposit", "monthly_income",
] as const;
function buildUserRedirect(lead: ValidLead, env: Env, routed: boolean, requestOrigin: string): string {
  const ref = encodeURIComponent(lead.lead_id.slice(-8));
  // Unsupported-state leads are never sent to the buyer's form.
  if (routed && (env.BUYER_MODE || "server_post") === "prepop_redirect" && env.LEADSGATE_PREPOP_URL) {
    // requestOrigin as base: LEADSGATE_PREPOP_URL is normally the relative "/apply" (same-repo,
    // brand-neutral page) so the redirect stays on whichever domain the visitor is actually on —
    // base is ignored if the configured value is ever still an absolute URL.
    const url = new URL(env.LEADSGATE_PREPOP_URL, requestOrigin);
    for (const key of BUYER_FIELDS) {
      const v = (lead.fields as Record<string, string>)[key];
      if (v) url.searchParams.set(key, v);
    }
    // ref = short lead ID for attribution (maps to _lg_form_init_.ref)
    url.searchParams.set("ref", lead.lead_id.slice(-8));
    url.searchParams.set("lead_id", lead.lead_id);
    // The account this lead sells under. ALWAYS set explicitly: apply.html carries a
    // hardcoded default, so omitting it sells under that account no matter which one
    // /go/ selected and logged — invisible with a one-entry pool, a wrong-account sale
    // with two. Re-validated here because the inbound URL is public and editable.
    // Deliberately NOT forwarding external_click_id: our SubID contains dots, it is
    // not needed buyer-side, and the join already closes in our own database.
    url.searchParams.set("aid", resolveAid(lead.tracking.aid, env));
    // click_id / clickid — LeadsGate reads click_id; apply.html maps clickid → click_id too
    const clickId = lead.tracking.clickid || lead.tracking.click_id;
    if (clickId) {
      url.searchParams.set("click_id", clickId);
      url.searchParams.set("clickid", clickId);
    }
    return url.toString();
  }
  // P0-A: Detect the silent failure where a routed lead should go to the buyer via
  // prepop_redirect, but LEADSGATE_PREPOP_URL is missing/empty. Without this the lead
  // is stored as "accepted" and the user sees the thank-you page, but LeadsGate never
  // receives it. Structured evidence only — no PII, just the short lead ref.
  if (routed && (env.BUYER_MODE || "server_post") === "prepop_redirect" && !env.LEADSGATE_PREPOP_URL) {
    console.error(JSON.stringify({
      msg: "prepop_redirect_misconfigured",
      reason: "LEADSGATE_PREPOP_URL_unset",
      lead_ref: ref,
      buyer_mode: env.BUYER_MODE,
      ts: Date.now(),
    }));
  }
  return `/thank-you.html?ref=${ref}`;
}
function validateLeadPayload(raw: unknown, env: Env):
  | { ok: true; value: ValidLead }
  | { ok: false; message: string } {
  if (!raw || typeof raw !== "object") return { ok: false, message: "Invalid payload" };
  const v = raw as Record<string, any>;
  const lead = v.lead as Record<string, any> | undefined;
  if (!lead || typeof lead !== "object") return { ok: false, message: "Missing lead fields" };

  if (!isUuidLike(v.lead_id) || !isUuidLike(v.session_id)) {
    return { ok: false, message: "Invalid identifiers" };
  }
  if (v.form_version !== env.FORM_VERSION) return { ok: false, message: "Unsupported form version" };
  if (v.site?.site_id !== env.FORM_SITE_ID) return { ok: false, message: "Invalid site" };

  // PHASE D — variant-scoped requirements. `lite_v1` collects five inputs; LeadsGate's own
  // pre-screen collects and qualifies the rest after handoff (measured 2026-09-08, see
  // _release-2026-09-08/LEADSGATE-FIELD-OVERLAP.md). Only ABSENCE is tolerated: a field that
  // arrives with a value is validated exactly as strictly as on the full form, so a forged
  // partial payload cannot smuggle a bad value through by claiming to be lite.
  //
  // NOT relaxed for lite, and never to be relaxed: requested_amount, first/last name, email,
  // home_phone, zip, and the whole consent block. ZIP is the compliance gate — handleLead
  // screens state via zipToState(zip); without it there is nothing to screen on.
  const LITE_VARIANT = "lite_v1";
  const isLite = clean(v.form_variant, 64) === LITE_VARIANT;
  const omitted = (val: unknown) => isLite && clean(val, 512).length === 0;

  const amount = Number(lead.requested_amount);
  if (!Number.isFinite(amount) || amount < 100 || amount > 5000) {
    return { ok: false, message: "Invalid requested amount" };
  }
  if (!omitted(lead.loan_purpose) && !LOAN_PURPOSES.has(clean(lead.loan_purpose, 64))) {
    return { ok: false, message: "Invalid loan purpose" };
  }

  const firstName = clean(lead.first_name, 128);
  const lastName = clean(lead.last_name, 128);
  if (!isName(firstName) || !isName(lastName)) return { ok: false, message: "Invalid name" };

  if (!omitted(lead.birth_date) && !isAgeInRange(lead.birth_date, 18, 95)) {
    return { ok: false, message: "Applicant must be 18-95" };
  }

  const email = clean(lead.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: "Invalid email" };

  const homePhone = clean(lead.home_phone, 20).replace(/\D/g, "");
  if (homePhone.length !== 10) return { ok: false, message: "Invalid home phone" };
  const workPhone = clean(lead.work_phone, 20).replace(/\D/g, "");
  if (workPhone && workPhone.length !== 10) return { ok: false, message: "Invalid work phone" };

  const address = clean(lead.address, 160);
  if (!omitted(lead.address) && address.length < 2) return { ok: false, message: "Invalid address" };
  const city = clean(lead.city, 100);
  if (!omitted(lead.city) && city.length < 2) return { ok: false, message: "Invalid city" };
  const state = clean(lead.state, 2).toUpperCase();
  // On lite the state is not asked; handleLead derives it from the ZIP and, when the ZIP is
  // unknown, gateState falls back to "" which isStateRoutable() rejects — fail-closed, so an
  // unresolvable ZIP is recorded and never sold rather than routed by default.
  if (!omitted(lead.state) && !US_STATES.has(state)) return { ok: false, message: "Invalid state" };
  // NEVER optional, on any variant: this is the state-screening gate.
  const zip = clean(lead.zip, 5).replace(/\D/g, "");
  if (!/^\d{5}$/.test(zip)) return { ok: false, message: "Invalid ZIP code" };

  const addressLengthMonths = Number(lead.address_length_months);
  const hasAddressLength = !omitted(lead.address_length_months);
  if (hasAddressLength && (!Number.isFinite(addressLengthMonths) || addressLengthMonths < 1 || addressLengthMonths > 120)) {
    return { ok: false, message: "Invalid address duration" };
  }
  const ownHome = clean(lead.own_home, 1);
  if (!omitted(lead.own_home) && ownHome !== "0" && ownHome !== "1") {
    return { ok: false, message: "Invalid housing status" };
  }

  if (!omitted(lead.income_type) && !INCOME_TYPES.has(clean(lead.income_type, 32))) {
    return { ok: false, message: "Invalid income type" };
  }

  const employer = clean(lead.employer, 128);
  const jobTitle = clean(lead.job_title, 128);
  if (!(omitted(lead.employer) && omitted(lead.job_title)) && (employer.length < 2 || jobTitle.length < 2)) {
    return { ok: false, message: "Invalid employer information" };
  }
  const employedMonths = Number(lead.employed_months);
  const hasEmployedMonths = !omitted(lead.employed_months);
  if (hasEmployedMonths && (!Number.isFinite(employedMonths) || employedMonths < 1 || employedMonths > 60)) {
    return { ok: false, message: "Invalid employment duration" };
  }

  const payDate1 = clean(lead.pay_date1, 10);
  if (!omitted(lead.pay_date1) && !isPayDateInRange(payDate1, 45)) {
    return { ok: false, message: "Invalid next payday" };
  }
  if (!omitted(lead.pay_frequency) && !PAY_FREQUENCIES.has(clean(lead.pay_frequency, 32))) {
    return { ok: false, message: "Invalid pay frequency" };
  }
  const directDeposit = clean(lead.direct_deposit, 1);
  if (!omitted(lead.direct_deposit) && directDeposit !== "0" && directDeposit !== "1") {
    return { ok: false, message: "Invalid paycheck method" };
  }

  const income = Number(lead.monthly_income);
  const hasIncome = !omitted(lead.monthly_income);
  if (hasIncome && (!Number.isFinite(income) || income < 1126 || income > 6000)) {
    return { ok: false, message: "Invalid monthly income" };
  }

  // Consent
  if (!v.consent?.application_consent) return { ok: false, message: "Consent required" };
  if (v.consent?.consent_version !== env.CONSENT_VERSION) return { ok: false, message: "Invalid consent version" };
  if (v.consent?.partner_list_version !== env.PARTNER_LIST_VERSION) {
    return { ok: false, message: "Invalid partner list version" };
  }

  const tracking: Record<string, string> = {};
  for (const key of TRACKING_KEYS) {
    const val = clean(v.tracking?.[key], 512);
    if (val) tracking[key] = val;
  }

  return {
    ok: true,
    value: {
      lead_id: clean(v.lead_id, 64),
      session_id: clean(v.session_id, 64),
      form_version: clean(v.form_version, 32),
      form_variant: clean(v.form_variant, 64),
      site: {
        site_id: clean(v.site.site_id, 64),
        brand: clean(v.site.brand, 80),
        hostname: clean(v.site.hostname, 255),
      },
      fields: {
        requested_amount: String(Math.round(amount)),
        loan_purpose: clean(lead.loan_purpose, 64),
        first_name: firstName,
        last_name: lastName,
        birth_date: clean(lead.birth_date, 10),
        email,
        home_phone: homePhone,
        work_phone: workPhone,
        address,
        city,
        state,
        zip,
        // Omitted numerics must serialise as "" — Math.round(Number("")) is 0 and
        // Math.round(Number(undefined)) is NaN, and either would be stored and forwarded to the
        // buyer as if the applicant had answered. buildUserRedirect skips empty params, so ""
        // means "not collected" all the way through.
        address_length_months: hasAddressLength ? String(Math.round(addressLengthMonths)) : "",
        own_home: ownHome,
        income_type: clean(lead.income_type, 32),
        employer,
        job_title: jobTitle,
        employed_months: hasEmployedMonths ? String(Math.round(employedMonths)) : "",
        pay_date1: payDate1,
        pay_frequency: clean(lead.pay_frequency, 32),
        direct_deposit: directDeposit,
        monthly_income: hasIncome ? String(Math.round(income)) : "",
      },
      consent: {
        application_consent: true,
        consent_version: clean(v.consent.consent_version, 64),
        partner_list_version: clean(v.consent.partner_list_version, 64),
        accepted_at: clean(v.consent.accepted_at, 40) || new Date().toISOString(),
        page_url: clean(v.consent.page_url, 1024),
      },
      tracking,
      metadata: {
        landing_page_url: clean(v.metadata?.landing_page_url, 1024),
        referrer: clean(v.metadata?.referrer, 1024),
        hostname: clean(v.metadata?.hostname, 255),
        submitted_at: clean(v.metadata?.submitted_at, 40),
      },
    },
  };
}

type ValidLead = {
  lead_id: string;
  session_id: string;
  form_version: string;
  form_variant: string;
  site: { site_id: string; brand: string; hostname: string };
  fields: {
    requested_amount: string; loan_purpose: string; first_name: string; last_name: string;
    birth_date: string; email: string; home_phone: string; work_phone: string; address: string;
    city: string; state: string; zip: string; address_length_months: string; own_home: string;
    income_type: string; employer: string; job_title: string; employed_months: string;
    pay_date1: string; pay_frequency: string; direct_deposit: string; monthly_income: string;
  };
  consent: {
    application_consent: true; consent_version: string; partner_list_version: string;
    accepted_at: string; page_url: string;
  };
  tracking: Record<string, string>;
  metadata: { landing_page_url: string; referrer: string; hostname: string; submitted_at: string };
};
function clean(value: unknown, maxLength: number): string {
  const s = String(value ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    out += s[i];
  }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isName(value: string): boolean {
  return value.length >= 2 && value.length <= 128 && /^[a-zA-Z\s\-']+$/.test(value);
}
const DEFAULT_ALLOWED_AID = "14881";

function allowedAids(env: Env): string[] {
  const raw = (env.ALLOWED_AIDS || DEFAULT_ALLOWED_AID).split(/[,\s]+/);
  const out = raw.map((s) => s.trim()).filter((s) => /^[A-Za-z0-9]+$/.test(s));
  return out.length ? out : [DEFAULT_ALLOWED_AID];
}

function resolveAid(raw: unknown, env: Env): string {
  const allow = allowedAids(env);
  const v = String(raw ?? "").trim();
  if (allow.includes(v)) return v;
  // Falling back is safe but never silent: this is also what fires when the /go/
  // rotation pool and ALLOWED_AIDS have drifted apart, in which case the lead sells
  // under the wrong account with nothing else to show for it.
  if (v) {
    console.warn(JSON.stringify({
      msg: "aid_not_allowed", requested: v.slice(0, 32), used: allow[0], ts: Date.now(),
    }));
  }
  return allow[0];
}

function isUuidLike(value: unknown): boolean {
  const s = String(value || "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
    || /^fallback-\d+-[0-9a-z]+$/i.test(s);
}

function isAgeInRange(value: unknown, min: number, max: number): boolean {
  const date = new Date(`${clean(value, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  const youngest = new Date(Date.UTC(now.getUTCFullYear() - min, now.getUTCMonth(), now.getUTCDate()));
  const oldest = new Date(Date.UTC(now.getUTCFullYear() - max - 1, now.getUTCMonth(), now.getUTCDate()));
  return date <= youngest && date >= oldest;
}

// Validates a YYYY-MM-DD "next payday" date is today..+maxDays (server-side clock, UTC day granularity).
function isPayDateInRange(value: unknown, maxDays: number): boolean {
  const date = new Date(`${clean(value, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const max = new Date(today);
  max.setUTCDate(max.getUTCDate() + maxDays);
  return date >= today && date <= max;
}

export { validateLeadPayload, buildUserRedirect, clean, isUuidLike, TRACKING_KEYS, BUYER_FIELDS };
export type { ValidLead };
