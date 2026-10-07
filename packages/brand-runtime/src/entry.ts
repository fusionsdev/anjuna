import { createBrandWorker, HttpsCoreClient, ServiceBindingCoreClient, type BrandWorkerConfig, type FetchBinding, type TransportOptions } from "./index.js";

interface Env {
  ASSETS: FetchBinding;
  CORE?: FetchBinding;
  CORE_TOKEN: string;
  /** Factory binds this as `json` (an object); wrangler `vars` may provide a string. */
  BRAND_CONFIG: string | Omit<BrandWorkerConfig, "core" | "assets">;
  CORE_ANALYTICS_PATHS?: string;
}

const instances = new WeakMap<Env, ReturnType<typeof createBrandWorker>>();

export default {
  fetch(request: Request, env: Env) {
    const cached = instances.get(env);
    if (cached) return cached.fetch(request);
    const options: TransportOptions = {
      credential: env.CORE_TOKEN,
      analyticsPaths: env.CORE_ANALYTICS_PATHS ? JSON.parse(env.CORE_ANALYTICS_PATHS) : undefined,
    };
    const core = env.CORE ? new ServiceBindingCoreClient(env.CORE, options) : new HttpsCoreClient(options);
    const settings = typeof env.BRAND_CONFIG === "string" ? JSON.parse(env.BRAND_CONFIG) : env.BRAND_CONFIG;
    const worker = createBrandWorker({ ...settings, core, assets: env.ASSETS });
    instances.set(env, worker);
    return worker.fetch(request);
  },
} satisfies ExportedHandler<Env>;
