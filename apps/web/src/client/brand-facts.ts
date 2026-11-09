import { CONVERSIONS_MAX_LIMIT, type PanelCampaignsResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api } from "./api";

/** What one source says, or that it is not known. `null` is unknown (loading, failed, or too big to answer); it never reads as zero. */
export type Known<T> = T | null;

/** Does the brand have any uploaded and any dead conversion in the period. */
export interface UploadFacts { uploaded: Known<boolean>; dead: Known<boolean> }

/**
 * Whether each brand has an uploaded and a dead conversion in the last 30 days.
 * One request per status asks for every brand at the largest page. When that page is complete (not truncated) a brand absent
 * from it has none. When it is cut, a brand absent from it is asked for on its own (limit 1): the answer is exact, never a guess
 * from a page that may hold other brands' rows. A request that fails leaves its answers unknown.
 */
export async function loadUploadFacts(brandIds: string[]): Promise<Map<string, UploadFacts>> {
  const facts = new Map<string, UploadFacts>(brandIds.map((id) => [id, { uploaded: null, dead: null }]));
  for (const status of ["uploaded", "dead"] as const) {
    const key = status;
    let page;
    try {
      page = await api.conversions({ period: "30d", status, limit: CONVERSIONS_MAX_LIMIT });
    } catch {
      continue;
    }
    const seen = new Set(page.rows.map((row) => row.brand));
    await Promise.all(brandIds.map(async (id) => {
      const fact = facts.get(id)!;
      if (seen.has(id)) { fact[key] = true; return; }
      if (!page.truncated) { fact[key] = false; return; }
      try {
        const own = await api.conversions({ period: "30d", status, brand: id, limit: 1 });
        fact[key] = own.rows.length > 0;
      } catch {
        fact[key] = null;
      }
    }));
  }
  return facts;
}

/** The upload facts of the given brands. `undefined` while loading. A change of the id list or of `refresh` reads again. */
export function useUploadFacts(brandIds: string[], refresh = 0): Map<string, UploadFacts> | undefined {
  const [facts, setFacts] = useState<Map<string, UploadFacts> | undefined>(undefined);
  const key = brandIds.join(",");
  useEffect(() => {
    if (brandIds.length === 0) { setFacts(new Map()); return; }
    let active = true;
    void loadUploadFacts(brandIds).then((result) => { if (active) setFacts(result); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh]);
  return facts;
}

/** The panel campaigns of every brand, read for the Google Ads chip. `undefined` loading, `null` failed. */
export function useAdsCampaigns(refresh = 0): PanelCampaignsResponse | null | undefined {
  const [data, setData] = useState<PanelCampaignsResponse | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    api.adsCampaigns().then((result) => { if (active) setData(result); }, () => { if (active) setData(null); });
    return () => { active = false; };
  }, [refresh]);
  return data;
}

/**
 * How many dead (failed) conversions one brand has in a period, for the AdKit block. The page is the largest one for that brand,
 * so the count is exact up to CONVERSIONS_MAX_LIMIT and `more` says it is cut there. `state` tells loading from failed.
 */
export function useBrandDeadCount(brandId: string | null, period: "today" | "7d" | "30d", enabled: boolean, refresh = 0): { state: "loading" | "error" | "ready"; count: number; more: boolean } {
  const [result, setResult] = useState<{ key: string; state: "error" | "ready"; count: number; more: boolean } | undefined>(undefined);
  const key = `${brandId}:${period}`;
  useEffect(() => {
    if (!enabled || !brandId) return;
    let active = true;
    api.conversions({ period, status: "dead", brand: brandId, limit: CONVERSIONS_MAX_LIMIT }).then(
      (report) => { if (active) setResult({ key, state: "ready", count: report.rows.length, more: report.truncated }); },
      () => { if (active) setResult({ key, state: "error", count: 0, more: false }); },
    );
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, refresh]);
  if (!result || result.key !== key) return { state: "loading", count: 0, more: false };
  return { state: result.state, count: result.count, more: result.more };
}

/**
 * The brand's gclid warning: landings of the last 24 hours that came without a gclid, from the same realtime report the Traffic page
 * reads. It warns when at least NO_GCLID_MIN_LANDINGS landings were counted and NO_GCLID_MIN_PCT percent of them had no gclid,
 * the thresholds the click risk alert uses (50 visits, 20 percent). A handful of landings says nothing.
 */
export const NO_GCLID_MIN_LANDINGS = 50;
export const NO_GCLID_MIN_PCT = 20;
export const noGclidWarning = (kpis: { landing_views: number; no_gclid_landings: { count: number; pct: number } }): boolean =>
  kpis.landing_views >= NO_GCLID_MIN_LANDINGS && kpis.no_gclid_landings.pct >= NO_GCLID_MIN_PCT;

/**
 * The gclid warning of each given brand. `true` warns, `false` is fine, and a brand whose read failed is absent (unknown).
 * Pass only brands that spend today: the warning is about paid clicks, so a brand with no spend is never asked.
 */
export function useNoGclid(brandIds: string[], refresh = 0): Map<string, boolean> {
  const [warnings, setWarnings] = useState<Map<string, boolean>>(new Map());
  const key = brandIds.join(",");
  useEffect(() => {
    if (brandIds.length === 0) { setWarnings(new Map()); return; }
    let active = true;
    void Promise.all(brandIds.map((id) => api.brandNoGclid(id).then((kpis) => [id, noGclidWarning(kpis)] as const, () => null))).then((answers) => {
      if (active) setWarnings(new Map(answers.filter((a): a is readonly [string, boolean] => a !== null)));
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh]);
  return warnings;
}
