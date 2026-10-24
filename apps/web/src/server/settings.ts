// spec settings (FUS-378): the Owner-only Settings read. One response holds every brand's full config.
import { GetBrandResponse, ListBrandsResponse, type AdminRequestContext, type BrandSummary } from "@anjuna/contracts";
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
