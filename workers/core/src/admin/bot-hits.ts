import type { AlertsReportResponse } from "@anjuna/contracts";
import type { Env } from "../env.js";
import { botHour } from "../rpc/bot-hit.js";

export const BOT_WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;

type BotHits = NonNullable<AlertsReportResponse["bot_hits"]>;
interface Row { brand_id: string; hour: string; kind: string; hits: number }

/** Reads the hourly crawler counters for the last 24 hours. Read-only, no money. */
export async function loadBotHits(env: Pick<Env, "LEADS">, now: string): Promise<BotHits> {
  const from = botHour(Date.parse(now) - (BOT_WINDOW_HOURS - 1) * HOUR_MS);
  const { results } = await env.LEADS.prepare(
    "SELECT brand_id, hour, kind, hits FROM bot_hits WHERE hour >= ?1 ORDER BY brand_id, hour",
  ).bind(from).all<Row>();
  const brands = new Map<string, { brand: string; googlebot: number; adsbot: number; other_bot: number }>();
  const adsbot_hours: BotHits["detail"]["adsbot_hours"] = [];
  for (const row of results) {
    const entry = brands.get(row.brand_id) ?? { brand: row.brand_id, googlebot: 0, adsbot: 0, other_bot: 0 };
    const hits = Number(row.hits);
    if (row.kind === "googlebot") entry.googlebot += hits;
    else if (row.kind === "adsbot") entry.adsbot += hits;
    else entry.other_bot += hits;
    brands.set(row.brand_id, entry);
    if (row.kind === "adsbot" && hits > 0) adsbot_hours.push({ brand: row.brand_id, hour: row.hour, hits });
  }
  return {
    state: adsbot_hours.length > 0 ? "alert" : "ok",
    detail: { window_hours: BOT_WINDOW_HOURS, brands: [...brands.values()], adsbot_hours },
  };
}
