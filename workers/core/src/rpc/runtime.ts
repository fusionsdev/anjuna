import { BrandSettingsResponse, BrandTheme, SiteBrandName, SiteDescription, SiteTitle, type BrandSettingsResponse as PublicSettings } from "@anjuna/contracts";
import type { Env } from "../env.js";

export interface RuntimeRow {
  brand_id: string;
  hostnames: string;
  aid: string;
  prepop_base: string;
  amount_buckets: string;
  flow_gate_mode: "param" | "signed_cookie";
  paused: number;
  ab_config_json: string | null;
  keyword_default: string | null;
  form_route: string;
  brand_name: string | null;
  site_title: string | null;
  site_description: string | null;
  theme_json: string | null;
}

export function getRuntime(env: Env, brandId: string): Promise<RuntimeRow | null> {
  return env.LEADS.prepare(`SELECT brand_id, hostnames, aid, prepop_base, amount_buckets,
    flow_gate_mode, paused, ab_config_json, keyword_default, form_route,
    brand_name, site_title, site_description, theme_json
    FROM brand_runtime WHERE brand_id = ?1`).bind(brandId).first<RuntimeRow>();
}

/** A stored value that no longer passes the site text rules is served as null (template default), never as a 503. */
function validOrNull(schema: { safeParse(value: unknown): { success: true; data: string } | { success: false } }, value: string | null): string | null {
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A stored theme that no longer parses as valid colors is served as null (template colors), never as a 503. */
export function parseStoredTheme(json: string | null): BrandTheme | null {
  if (json === null) return null;
  try {
    const parsed = BrandTheme.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function publicSettings(row: RuntimeRow, includeSiteText = false, includeTheme = false): PublicSettings {
  return BrandSettingsResponse.parse({
    flow_gate_mode: row.flow_gate_mode, paused: row.paused === 1,
    amount_buckets: JSON.parse(row.amount_buckets),
    ab_config: row.ab_config_json === null ? null : JSON.parse(row.ab_config_json),
    keyword_default: row.keyword_default, form_route: row.form_route,
    // Old brand runtimes parse this response strictly: add site text only when asked.
    ...(includeSiteText ? {
      brand_name: validOrNull(SiteBrandName, row.brand_name),
      site_title: validOrNull(SiteTitle, row.site_title),
      site_description: validOrNull(SiteDescription, row.site_description),
    } : {}),
    // Old brand runtimes parse this response strictly: add the theme only when asked.
    ...(includeTheme ? { theme: parseStoredTheme(row.theme_json) } : {}),
  });
}

export function ownsHostname(row: RuntimeRow, hostname: string): boolean {
  const hosts: unknown = JSON.parse(row.hostnames);
  return Array.isArray(hosts) && hosts.includes(hostname);
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}
