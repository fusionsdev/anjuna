import { BrandAssetResponse, type LeadsRpcRequest } from "@anjuna/contracts";
import type { Env } from "../env.js";
import { json } from "../http.js";

/**
 * The favicon or logo the panel stored for the brand (factory `brand_assets`). The brand Worker serves the bytes to every
 * visitor, so the answer depends only on the brand and kind. A row that no longer fits the contract is served as missing.
 */
export async function brandAsset(input: LeadsRpcRequest<"brandAsset">, env: Env): Promise<Response> {
  const row = await env.FACTORY.prepare("SELECT content_type, sha256, body_base64 FROM brand_assets WHERE brand_id = ?1 AND kind = ?2")
    .bind(input.brand_id, input.kind).first<{ content_type: string; sha256: string; body_base64: string }>();
  const parsed = BrandAssetResponse.safeParse(row);
  return parsed.success ? json(parsed.data) : json({ error: "not_found" }, 404);
}
