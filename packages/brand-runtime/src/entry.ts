import { reportBotHit } from "./bot-log.js";
import { createBrandWorker, HttpsCoreClient, ServiceBindingCoreClient, type BrandWorkerConfig, type CoreClient, type FetchBinding, type TransportOptions } from "./index.js";

interface Env {
  ASSETS: FetchBinding;
  CORE?: FetchBinding;
  CORE_TOKEN: string;
  /** Factory binds this as `json` (an object); wrangler `vars` may provide a string. */
  BRAND_CONFIG: string | Omit<BrandWorkerConfig, "core" | "assets">;
  CORE_ANALYTICS_PATHS?: string;
}

interface Instance { worker: ReturnType<typeof createBrandWorker>; core: CoreClient; brand_id: string }
const instances = new WeakMap<Env, Instance>();

/** Counts a crawler hit after the response exists. waitUntil keeps it off the request path. */
function logBotHit(instance: Instance, request: Request, ctx?: Pick<ExecutionContext, "waitUntil">) {
  ctx?.waitUntil(reportBotHit(instance.core, { brand_id: instance.brand_id, request }));
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext) {
    let instance = instances.get(env);
    if (!instance) {
      const options: TransportOptions = {
        credential: env.CORE_TOKEN,
        analyticsPaths: env.CORE_ANALYTICS_PATHS ? JSON.parse(env.CORE_ANALYTICS_PATHS) : undefined,
      };
      const core = env.CORE ? new ServiceBindingCoreClient(env.CORE, options) : new HttpsCoreClient(options);
      const settings = typeof env.BRAND_CONFIG === "string" ? JSON.parse(env.BRAND_CONFIG) : env.BRAND_CONFIG;
      instance = { worker: createBrandWorker({ ...settings, core, assets: env.ASSETS }), core, brand_id: settings.brand_id };
      instances.set(env, instance);
    }
    const response = await instance.worker.fetch(request);
    logBotHit(instance, request, ctx);
    return response;
  },
} satisfies ExportedHandler<Env>;
