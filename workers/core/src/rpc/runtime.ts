import { BrandSettingsResponse, type BrandSettingsResponse as PublicSettings } from "@anjuna/contracts";
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
}

export function getRuntime(env: Env, brandId: string): Promise<RuntimeRow | null> {
  return env.LEADS.prepare(`SELECT brand_id, hostnames, aid, prepop_base, amount_buckets,
    flow_gate_mode, paused, ab_config_json, keyword_default, form_route
    FROM brand_runtime WHERE brand_id = ?1`).bind(brandId).first<RuntimeRow>();
}

export function publicSettings(row: RuntimeRow): PublicSettings {
  return BrandSettingsResponse.parse({
    flow_gate_mode: row.flow_gate_mode, paused: row.paused === 1,
    amount_buckets: JSON.parse(row.amount_buckets),
    ab_config: row.ab_config_json === null ? null : JSON.parse(row.ab_config_json),
    keyword_default: row.keyword_default, form_route: row.form_route,
  });
}

export function ownsHostname(row: RuntimeRow, hostname: string): boolean {
  const hosts: unknown = JSON.parse(row.hostnames);
  return Array.isArray(hosts) && hosts.includes(hostname);
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}
