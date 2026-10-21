/**
 * Read-only zone pre-check for the panel's brand wizard. It answers what the install `validate` step
 * would find for a domain (zone active, no A/AAAA/CNAME on the brand hostnames) before a draft exists.
 * It uses the same token and helpers as `validate` and never creates, changes or deletes a record.
 */
import { apexDnsRecords, blockingDnsRecords, brandHostnames, cfFetch, type CfFetch, type ZoneInfo } from "./cf-api.js";

export interface ZoneCheckResult {
  /** True when a zone covering the domain exists and its status is active. */
  zone_active: boolean;
  /** The zone covering the domain, or null when the account has none. */
  zone_name: string | null;
  /** Cloudflare name servers to set at the registrar. Empty when there is no zone. */
  nameservers: string[];
  /** A, AAAA and CNAME records on the brand hostnames that would block the Custom Domain attach. Empty unless the zone is active. */
  conflicting_records: Array<{ type: string; name: string }>;
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}$/;
const BRAND_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The zone covering `domain` (the domain itself, then each parent), whatever its status. Null when none. */
async function findZone(token: string, domain: string, fetcher?: CfFetch): Promise<ZoneInfo | null> {
  const labels = domain.split(".").filter(Boolean);
  for (let skip = 0; skip <= labels.length - 2; skip++) {
    const name = labels.slice(skip).join(".");
    const zones = await cfFetch<ZoneInfo[]>(token, "GET", `/zones?name=${encodeURIComponent(name)}&per_page=1`, undefined, undefined, fetcher);
    if (zones[0]) return zones[0];
  }
  return null;
}

export function parseZoneCheckRequest(input: unknown): { domain: string; brand_id?: string } | null {
  if (!input || typeof input !== "object") return null;
  const { domain, brand_id } = input as { domain?: unknown; brand_id?: unknown };
  if (typeof domain !== "string" || !DOMAIN.test(domain)) return null;
  if (brand_id === undefined) return { domain };
  return typeof brand_id === "string" && BRAND_ID.test(brand_id) ? { domain, brand_id } : null;
}

/**
 * With `brandId`, records on hostnames already attached to that brand's own Worker do not count,
 * as in `validate`. Without it every A, AAAA or CNAME on the hostnames counts.
 */
export async function zoneCheck(
  token: string, accountId: string, domain: string, brandId?: string, fetcher?: CfFetch,
): Promise<ZoneCheckResult> {
  const zone = await findZone(token, domain, fetcher);
  if (!zone) return { zone_active: false, zone_name: null, nameservers: [], conflicting_records: [] };
  const nameservers = zone.name_servers ?? [];
  if (zone.status !== "active") return { zone_active: false, zone_name: zone.name, nameservers, conflicting_records: [] };
  const hostnames = brandHostnames(domain, zone.name);
  const records = brandId
    ? await blockingDnsRecords(token, accountId, zone.id, `brand-${brandId}`, hostnames, fetcher)
    : await apexDnsRecords(token, zone.id, hostnames, fetcher);
  return { zone_active: true, zone_name: zone.name, nameservers, conflicting_records: records.map(({ type, name }) => ({ type, name })) };
}
