import { createBrandWorker, HttpsCoreClient, ServiceBindingCoreClient, type BrandWorkerConfig, type FetchBinding, type TransportOptions } from "../src/index.js";

interface Env {
  ASSETS: FetchBinding;
  CORE?: FetchBinding;
  CORE_TOKEN: string;
  /** JSON provisioned by the factory; credentials never belong here. */
  BRAND_CONFIG: string;
  /** Explicit path mapping agreed with the core installation (no keys or DSNs). */
  CORE_ANALYTICS_PATHS?: string;
}

// Preserve the client and handler across requests so its 60-second settings cache is effective.
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
    const settings = JSON.parse(env.BRAND_CONFIG) as Omit<BrandWorkerConfig, "core" | "assets">;
    const worker = createBrandWorker({ ...settings, core, assets: env.ASSETS });
    instances.set(env, worker);
    return worker.fetch(request);
  },
} satisfies ExportedHandler<Env>;
