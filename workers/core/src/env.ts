export interface Env {
  LEADS: D1Database;
  FACTORY: D1Database;
  DRAIN_TOKEN?: string;
  HANDOFF_KEY?: string;
  HANDOFF_KEY_ID?: string;
  FORM_SITE_ID?: string;
  FORM_VERSION?: string;
  CONSENT_VERSION?: string;
  PARTNER_LIST_VERSION?: string;
}
