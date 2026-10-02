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

export default {
  fetch(request: Request, env: Env) {
    const options: TransportOptions = {
      credential: env.CORE_TOKEN,
      analyticsPaths: env.CORE_ANALYTICS_PATHS ? JSON.parse(env.CORE_ANALYTICS_PATHS) : undefined,
    };
    const core = env.CORE ? new ServiceBindingCoreClient(env.CORE, options) : new HttpsCoreClient(options);
    const settings = JSON.parse(env.BRAND_CONFIG) as Omit<BrandWorkerConfig, "core" | "assets">;
    return createBrandWorker({ ...settings, core, assets: env.ASSETS }).fetch(request);
  },
} satisfies ExportedHandler<Env>;
