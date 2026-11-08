import type { BotHitRequest } from "@anjuna/contracts";
import type { Env } from "../env.js";
import { json } from "../http.js";

const HOUR_MS = 3_600_000;

/** UTC clock hour as an ISO string, e.g. 2026-11-07T06:00:00Z. */
export function botHour(ms: number): string {
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().replace(".000Z", "Z");
}

/** Counts one crawler hit. The brand Worker clock is trusted only within one hour of core's. */
export async function botHit(input: BotHitRequest, env: Env, now = Date.now()): Promise<Response> {
  const reported = Date.parse(input.at);
  const at = Math.abs(reported - now) <= HOUR_MS ? reported : now;
  await env.LEADS.prepare(`INSERT INTO bot_hits (brand_id, hour, kind, hits) VALUES (?1, ?2, ?3, 1)
    ON CONFLICT (brand_id, hour, kind) DO UPDATE SET hits = hits + 1`)
    .bind(input.brand_id, botHour(at), input.kind).run();
  return json({ ok: true });
}
