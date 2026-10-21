import { BrandAssetBody, base64ToBytes, brandInitialSvg, checkBrandAssetBytes, isBrandClean, type BrandAssetContentType, type BrandAssetKind } from "@anjuna/contracts";
import type { BrandSettings, BrandWorkerConfig } from "./config.js";
import { withCoreTimeout, type CoreClient } from "./core-client.js";

/** A stored favicon or logo, decoded and checked again before it is served. */
export interface ServedAsset { bytes: Uint8Array; contentType: BrandAssetContentType }

export const ASSET_TTL_MS = 60_000;
interface Entry { expires: number; value: ServedAsset | null; pending?: Promise<void> }

/**
 * The brand's favicon and logo from core, per Worker instance, per credential/client, per brand and kind. A missing file, an
 * outage or bytes that fail the checks again all mean "no uploaded file": the caller falls back, so the page never breaks on an icon.
 */
export function createAssetCache() {
  const clients = new WeakMap<CoreClient, Map<string, Entry>>();
  return async (config: BrandWorkerConfig, settings: BrandSettings, kind: BrandAssetKind): Promise<ServedAsset | null> => {
    let cache = clients.get(config.core);
    if (!cache) { cache = new Map(); clients.set(config.core, cache); }
    const key = `${settings.brand_id}:${settings.hostname}:${kind}`;
    let entry = cache.get(key);
    if (!entry) { entry = { expires: 0, value: null }; cache.set(key, entry); }
    const current = entry;
    if (!current.pending && current.expires <= Date.now()) {
      current.pending = (async () => {
        try {
          const result = await withCoreTimeout(() => config.core.brandAsset({ brand_id: settings.brand_id, kind }), config.coreTimeoutMs);
          if (result.status !== 200) throw new Error("no asset");
          const body = BrandAssetBody.parse(result.data);
          const bytes = base64ToBytes(body.body_base64);
          const checked = checkBrandAssetBytes(kind, bytes);
          // The same rule as every other byte a brand serves (AGENTS.md rule 4): no platform name, whatever the type.
          if (!checked.ok || !isBrandClean(new TextDecoder().decode(bytes))) throw new Error("asset refused");
          current.value = { bytes, contentType: checked.content_type };
        } catch { current.value = null; }
        finally { current.expires = Date.now() + ASSET_TTL_MS; }
      })();
      try { await current.pending; } finally { delete current.pending; }
    } else if (current.pending) await current.pending;
    return current.value;
  };
}

const ASSET_HEADERS = { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } as const;
/** An SVG is a document on the brand's own origin: it may style itself and nothing else. */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** The same bytes and headers for every visitor and every request header. */
export function assetResponse(bytes: Uint8Array, contentType: BrandAssetContentType): Response {
  return new Response(bytes, { status: 200, headers: {
    ...ASSET_HEADERS, "content-type": contentType,
    ...(contentType === "image/svg+xml" ? { "content-security-policy": SVG_CSP } : {}),
  } });
}

/** The first letter of the brand name on a colored square. It stands in for a favicon or logo nobody uploaded. */
export function initialResponse(brandName: string): Response {
  return new Response(brandInitialSvg(brandName), { status: 200, headers: {
    ...ASSET_HEADERS, "content-type": "image/svg+xml", "content-security-policy": SVG_CSP,
  } });
}
