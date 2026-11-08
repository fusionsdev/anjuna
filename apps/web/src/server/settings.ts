// spec settings (FUS-378): the Owner-only Settings read. One response holds every brand's full config.
// Panel-wide keys (`panel_settings` in the factory D1): fx_thb_per_usd and the ads caps, read and written by the owner only.
import {
  ADS_CAP_BRAND_KEY, ADS_CAP_TOTAL_KEY, AdsCapsSettingRequest, DEFAULT_ADS_CAP_THB_DAY, DEFAULT_THB_PER_USD, FX_THB_PER_USD_KEY, GetBrandResponse,
  ListBrandsResponse, MicrosoftAdsAccount, ThbPerDay, type AdminRequestContext, type BrandSummary,
} from "@anjuna/contracts";
import { z } from "zod";
import { SettingsBrandsResponse, type SettingsRow } from "../shared/settings.js";
import { callCore, type CoreResult } from "./core.js";
import type { Env } from "./env.js";
import { authorizePanel } from "./panel-roles.js";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

const GET_BRAND_LIMIT = 6;

/** One getBrand per summary, at most `limit` in flight. A failed or malformed getBrand becomes an error row, never a failed page. */
export async function buildSettingsRows(
  summaries: Pick<BrandSummary, "brand_id" | "hostnames">[],
  getBrand: (brandId: string) => Promise<CoreResult>,
  limit = GET_BRAND_LIMIT,
): Promise<SettingsRow[]> {
  const rows: SettingsRow[] = new Array(summaries.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < summaries.length) {
      const index = next++;
      const summary = summaries[index]!;
      const errorRow: SettingsRow = { brand_id: summary.brand_id, hostname: summary.hostnames[0]!, brand: null, error: "unavailable" };
      try {
        const result = await getBrand(summary.brand_id);
        const parsed = result.status >= 200 && result.status < 300 ? GetBrandResponse.safeParse(result.body) : null;
        rows[index] = parsed?.success
          ? { brand_id: summary.brand_id, hostname: parsed.data.brand.hostnames[0]!, brand: parsed.data.brand, error: null }
          : errorRow;
      } catch {
        rows[index] = errorRow;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), summaries.length) }, worker));
  return rows.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

export async function handleSettingsRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (request.method !== "GET" || path !== "/api/settings/brands") return undefined;
  const gate = authorizePanel("viewSettings", ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  const listed = await callCore(env, ctx, { endpoint: "listBrands" });
  if (listed.status !== 200) return json(listed.status, listed.body);
  const list = ListBrandsResponse.parse(listed.body);
  const rows = await buildSettingsRows(list.brands, (id) => callCore(env, ctx, { endpoint: "getBrand", params: { id } }));
  return json(200, SettingsBrandsResponse.parse({ rows, generated_at: new Date().toISOString() }));
}

/** Baht per US dollar for ad spend in USD and profit. The key and the default of 35 live in contracts so core reads the same. */
export { DEFAULT_THB_PER_USD, FX_THB_PER_USD_KEY };

/** Positive and at most 1000, so a slip such as 3500 for 35 is refused. */
const ThbPerUsd = z.number().finite().positive().max(1000);
export const FxSettingRequest = z.strictObject({ thbPerUsd: ThbPerUsd });
export interface FxSetting { thbPerUsd: number; updated_at: string | null }

/** The stored rate, or the default with `updated_at: null` when no owner has set one. */
export async function readFxSetting(db: D1Database): Promise<FxSetting> {
  const row = await db.prepare("SELECT value_json, updated_at FROM panel_settings WHERE key = ?1")
    .bind(FX_THB_PER_USD_KEY).first<{ value_json: string; updated_at: string }>();
  if (!row) return { thbPerUsd: DEFAULT_THB_PER_USD, updated_at: null };
  return { thbPerUsd: ThbPerUsd.parse(JSON.parse(row.value_json)), updated_at: row.updated_at };
}

/** GET and PUT /api/settings/fx. Both use the owner-only Settings gate. A PUT writes the row and its audit_log row in one batch. */
export async function handleFxSettingRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/settings/fx" || (request.method !== "GET" && request.method !== "PUT")) return undefined;
  const gate = authorizePanel("viewSettings", ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  if (request.method === "GET") return json(200, await readFxSetting(env.FACTORY));

  const parsed = FxSettingRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json(422, { error: "invalid", request_id: ctx.request_id, issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
  }
  const before = await readFxSetting(env.FACTORY);
  const at = new Date().toISOString();
  await env.FACTORY.batch([
    env.FACTORY.prepare(
      `INSERT INTO panel_settings (key, value_json, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(FX_THB_PER_USD_KEY, JSON.stringify(parsed.data.thbPerUsd), ctx.actor_id, at),
    env.FACTORY.prepare(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, 'settings.fx_rate', 'panel_setting', ?3, ?4, ?5, ?6)`,
    ).bind(ctx.actor_id, ctx.actor_role, FX_THB_PER_USD_KEY, JSON.stringify({ thbPerUsd: before.thbPerUsd }), JSON.stringify({ thbPerUsd: parsed.data.thbPerUsd }), at),
  ]);
  return json(200, { thbPerUsd: parsed.data.thbPerUsd, updated_at: at });
}

/** The global Microsoft Ads account (panel redesign Task 10): it left the wizard and lives here, owner only. */
export const MICROSOFT_ADS_ACCOUNT_KEY = "microsoft_ads_account";
export const MicrosoftAdsSettingRequest = z.strictObject({ microsoft_ads_account: MicrosoftAdsAccount.nullable() });
export interface MicrosoftAdsSetting { microsoft_ads_account: string | null; updated_at: string | null }

export async function readMicrosoftAdsSetting(db: D1Database): Promise<MicrosoftAdsSetting> {
  const row = await db.prepare("SELECT value_json, updated_at FROM panel_settings WHERE key = ?1")
    .bind(MICROSOFT_ADS_ACCOUNT_KEY).first<{ value_json: string; updated_at: string }>();
  if (!row) return { microsoft_ads_account: null, updated_at: null };
  return { microsoft_ads_account: MicrosoftAdsAccount.nullable().parse(JSON.parse(row.value_json)), updated_at: row.updated_at };
}

/** GET and PUT /api/settings/microsoft-ads. Owner only. A PUT writes the row and its audit_log row in one batch. */
export async function handleMicrosoftAdsSettingRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/settings/microsoft-ads" || (request.method !== "GET" && request.method !== "PUT")) return undefined;
  const gate = authorizePanel("setMicrosoftAdsSetting", ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  if (request.method === "GET") return json(200, await readMicrosoftAdsSetting(env.FACTORY));

  const parsed = MicrosoftAdsSettingRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json(422, { error: "invalid", request_id: ctx.request_id, issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
  }
  const before = await readMicrosoftAdsSetting(env.FACTORY);
  const next = parsed.data.microsoft_ads_account;
  const at = new Date().toISOString();
  await env.FACTORY.batch([
    env.FACTORY.prepare(
      `INSERT INTO panel_settings (key, value_json, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(MICROSOFT_ADS_ACCOUNT_KEY, JSON.stringify(next), ctx.actor_id, at),
    env.FACTORY.prepare(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, 'settings.microsoft_ads_account', 'panel_setting', ?3, ?4, ?5, ?6)`,
    ).bind(ctx.actor_id, ctx.actor_role, MICROSOFT_ADS_ACCOUNT_KEY, JSON.stringify({ microsoft_ads_account: before.microsoft_ads_account }), JSON.stringify({ microsoft_ads_account: next }), at),
  ]);
  return json(200, { microsoft_ads_account: next, updated_at: at });
}

/** Baht caps for panel campaigns (T13 Part B). Core reads the same keys before it queues a draft or an enable. */
export interface AdsCapsSetting { total_thb_day: number; brand_thb_day: number; updated_at: string | null }

/** The stored caps, the 3,000 baht default for a key no owner has set. */
export async function readAdsCapsSetting(db: D1Database): Promise<AdsCapsSetting> {
  const { results } = await db.prepare("SELECT key, value_json, updated_at FROM panel_settings WHERE key IN (?1, ?2)")
    .bind(ADS_CAP_TOTAL_KEY, ADS_CAP_BRAND_KEY).all<{ key: string; value_json: string; updated_at: string }>();
  const byKey = new Map(results.map((r) => [r.key, r]));
  const cap = (key: string) => {
    const row = byKey.get(key);
    return row ? ThbPerDay.parse(JSON.parse(row.value_json)) : DEFAULT_ADS_CAP_THB_DAY;
  };
  const updated = results.map((r) => r.updated_at).sort().at(-1) ?? null;
  return { total_thb_day: cap(ADS_CAP_TOTAL_KEY), brand_thb_day: cap(ADS_CAP_BRAND_KEY), updated_at: updated };
}

/** GET and PUT /api/settings/ads-caps. Owner only. A brand cap above the total cap is 422. One batch writes both rows and the audit row. */
export async function handleAdsCapsSettingRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/settings/ads-caps" || (request.method !== "GET" && request.method !== "PUT")) return undefined;
  const gate = authorizePanel("viewSettings", ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  if (request.method === "GET") return json(200, await readAdsCapsSetting(env.FACTORY));

  const parsed = AdsCapsSettingRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json(422, { error: "invalid", request_id: ctx.request_id, issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
  }
  const before = await readAdsCapsSetting(env.FACTORY);
  const next = parsed.data;
  const at = new Date().toISOString();
  const upsert = (key: string, value: number) => env.FACTORY.prepare(
    `INSERT INTO panel_settings (key, value_json, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(key, JSON.stringify(value), ctx.actor_id, at);
  await env.FACTORY.batch([
    upsert(ADS_CAP_TOTAL_KEY, next.total_thb_day),
    upsert(ADS_CAP_BRAND_KEY, next.brand_thb_day),
    env.FACTORY.prepare(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, 'settings.ads_caps', 'panel_setting', 'ads_caps', ?3, ?4, ?5)`,
    ).bind(ctx.actor_id, ctx.actor_role,
      JSON.stringify({ total_thb_day: before.total_thb_day, brand_thb_day: before.brand_thb_day }), JSON.stringify(next), at),
  ]);
  return json(200, { ...next, updated_at: at });
}
