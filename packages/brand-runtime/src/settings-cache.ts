import { BrandSettingsResponse, type BrandSettingsResponse as PublicSettings } from "@anjuna/contracts";
import { BrandSettings, type BrandWorkerConfig } from "./config.js";
import { CoreError, withCoreTimeout, type CoreClient } from "./core-client.js";

export const SETTINGS_TTL_MS = 60_000;
interface Entry { expires: number; value: PublicSettings | null; pending?: Promise<void> }

/** Per Worker instance, per credential/client, per brand. Concurrent refreshes share one request. */
export function createSettingsCache() {
  const clients = new WeakMap<CoreClient, Map<string, Entry>>();
  return async (config: BrandWorkerConfig): Promise<BrandSettings> => {
    const fallback = BrandSettings.parse(config);
    let cache = clients.get(config.core);
    if (!cache) { cache = new Map(); clients.set(config.core, cache); }
    const cacheKey = `${fallback.brand_id}:${fallback.hostname}`;
    let entry = cache.get(cacheKey);
    if (!entry) { entry = { expires: 0, value: null }; cache.set(cacheKey, entry); }
    const current = entry;
    if (!current.pending && current.expires <= Date.now()) {
      current.pending = (async () => {
        try {
          const result = await withCoreTimeout(() => config.core.brandSettings({ brand_id: fallback.brand_id }), config.coreTimeoutMs);
          if (result.status !== 200) throw new CoreError(result.status);
          const live = BrandSettingsResponse.parse(result.data);
          // Apply existing identity/route checks before caching anything that will be served.
          BrandSettings.parse({ ...fallback, ...live, formRoute: live.form_route });
          current.value = live;
        } catch { current.value = null; }
        finally { current.expires = Date.now() + SETTINGS_TTL_MS; }
      })();
      try { await current.pending; } finally { delete current.pending; }
    } else if (current.pending) await current.pending;
    if (!current.value) return fallback;
    const combined = BrandSettings.safeParse({ ...fallback, ...current.value, formRoute: current.value.form_route });
    return combined.success ? combined.data : fallback;
  };
}
