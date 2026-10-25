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
          const load = async (flags: { include_site_text?: true; include_theme?: true }) => {
            const body = { brand_id: fallback.brand_id, ...flags };
            const result = await withCoreTimeout(() => config.core.brandSettings(body), config.coreTimeoutMs);
            if (result.status !== 200) throw new CoreError(result.status);
            return result;
          };
          const retry = (next: () => ReturnType<typeof load>) => (error: unknown) => {
            if (error instanceof CoreError && error.status === 400) return next();
            throw error;
          };
          // A core deployed before brand colors refuses the include_theme key with 400. Ask once more without
          // it; that answer has no theme, so the page keeps the template's colors. A core deployed before site
          // text refuses include_site_text as well; the bare answer has no site text, so the page keeps the
          // template's text.
          const result = await load({ include_site_text: true, include_theme: true })
            .catch(retry(() => load({ include_site_text: true })))
            .catch(retry(() => load({})));
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
