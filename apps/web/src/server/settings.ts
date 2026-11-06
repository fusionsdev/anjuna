// spec settings (FUS-378): the Owner-only Settings read. One response holds every brand's full config.
// Panel-wide keys (`panel_settings` in the factory D1): fx_thb_per_usd, read and written by the owner only.
import { GetBrandResponse, ListBrandsResponse, type AdminRequestContext, type BrandSummary } from "@anjuna/contracts";
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

/** Baht per US dollar for ad spend in USD and profit. The owner confirmed 35 as the starting rate. */
export const FX_THB_PER_USD_KEY = "fx_thb_per_usd";
export const DEFAULT_THB_PER_USD = 35;

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
