import { CLICK_TRIGGER_KEYS, type RecordClickRequest, type ZipRequest } from "@anjuna/contracts";
import type { Env } from "../env.js";
import { json } from "../http.js";
import { randomToken } from "./runtime.js";

export async function recordClick(input: RecordClickRequest, env: Env): Promise<Response> {
  const p = input.params;
  if (!CLICK_TRIGGER_KEYS.some((key) => p[key]?.trim())) return json({ error: "invalid" }, 400);
  const id = randomToken();
  const now = new Date().toISOString();
  const columns = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid", "external_click_id",
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "source", "aid", "keyword"] as const;
  let referrer: string | null = null;
  try {
    const url = new URL(input.referrer_origin ?? "");
    if (["http:", "https:"].includes(url.protocol)) referrer = url.origin;
  } catch { /* V1 ignores malformed referrers. */ }
  await env.LEADS.prepare(`INSERT INTO click_sessions (click_session_id, ${columns.join(",")},
    landing_path, referrer_origin, click_seen_at, first_seen_at, last_seen_at, created_at,
    hostname, brand_id, experiment_id, variant)
    VALUES (${Array.from({ length: 25 }, () => "?").join(",")})`).bind(
    id, ...columns.map((key) => p[key]?.trim().slice(0, 512) || null),
    input.landing_path.split(/[?#]/)[0], referrer, now, now, now, now,
    input.hostname.replace(/^www\./, ""), input.brand_id, input.experiment_id ?? null, input.variant ?? null,
  ).run();
  return json({ click_session_id: id });
}

export async function zip(input: ZipRequest, env: Env): Promise<Response> {
  const value = input.zip.padStart(5, "0");
  const row = await env.LEADS.prepare("SELECT city, state FROM zip_lookup WHERE zip = ?1 LIMIT 1")
    .bind(value).first<{ city: string; state: string }>();
  return row ? json({ found: true, zip: value, city: row.city, state: row.state }) : json({ found: false }, 404);
}
