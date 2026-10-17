import { z } from "zod";
import {
  AbConfig, AmountBuckets, BrandId, FlowGateMode, FormRoute, Hostname, ProxyPaths, RuntimeConfig,
  SiteBrandName, SiteDescription, SiteTitle, TemplateTextDefaults, isBrandClean,
} from "@anjuna/contracts";
import type { CoreClient, FetchBinding } from "./core-client.js";

export const LEGAL_PATHS = ["/privacy", "/terms", "/disclosures", "/do-not-sell"] as const;
export const STATIC_PREFIXES = ["/_f/assets/", "/assets/", "/_astro/"] as const;
export const STATIC_FILES = ["/favicon.ico", "/favicon.svg"] as const;

/** Catch unknown routes in the Worker, excluding only certified public asset directories. */
export const RUN_WORKER_FIRST = ["/*", ...STATIC_PREFIXES.map((path) => `!${path}*`), ...STATIC_FILES.map((path) => `!${path}`)];

export const BrandSettings = z.object({
  brand_id: BrandId,
  hostname: Hostname.refine((host) => !host.startsWith("www."), "Use the apex hostname"),
  brand: RuntimeConfig.shape.brand,
  formRoute: FormRoute.refine(isBrandClean)
    .refine((route) => route !== "/apply" && !route.startsWith("/apply/"), "Form route collides with the application page"),
  amount_buckets: AmountBuckets,
  flow_gate_mode: FlowGateMode.default("param"),
  paused: z.boolean().default(false),
  keyword_default: z.string().nullable().default(null),
  /** Template defaults baked into the revision (factory config_json.text_defaults). Invalid values become null. */
  text_defaults: TemplateTextDefaults.nullable().default(null).catch(null),
  /** Dashboard site text from core live settings. Null = template default. */
  brand_name: SiteBrandName.nullable().default(null).catch(null),
  site_title: SiteTitle.nullable().default(null).catch(null),
  site_description: SiteDescription.nullable().default(null).catch(null),
  default_variant: RuntimeConfig.shape.variant.default("lite_v1"),
  ab_config: AbConfig.nullable().default(null),
  proxies: ProxyPaths.default({ posthog: "/_t", sentry: "/_e" }),
}).superRefine((settings, ctx) => {
  if ([...STATIC_PREFIXES.map((prefix) => prefix.slice(0, -1)), ...STATIC_FILES].some((path) => settings.formRoute === path || settings.formRoute.startsWith(`${path}/`))) {
    ctx.addIssue({ code: "custom", path: ["formRoute"], message: "Form route collides with public assets" });
  }
  if (settings.ab_config && (!isBrandClean(settings.ab_config.experiment_id) ||
      settings.ab_config.variants.some((variant) => !isBrandClean(variant.id)))) {
    ctx.addIssue({ code: "custom", path: ["ab_config"], message: "Experiment identifiers must be brand clean" });
  }
  const paths = Object.values(settings.proxies).filter((path): path is string => path !== undefined);
  const reserved = ["/go", "/apply", "/api", "/_f", "/assets", "/_astro", ...LEGAL_PATHS, ...STATIC_FILES, settings.formRoute];
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  for (const path of paths) {
    if (path.endsWith("/") || path.includes("//") || !isBrandClean(path) || reserved.some((item) => overlaps(path, item))) {
      ctx.addIssue({ code: "custom", path: ["proxies"], message: "Proxy path collides with a reserved route" });
    }
  }
  if (paths.length === 2 && overlaps(paths[0]!, paths[1]!)) {
    ctx.addIssue({ code: "custom", path: ["proxies"], message: "Proxy paths must be distinct" });
  }
});

export type BrandSettings = z.output<typeof BrandSettings>;
export type BrandWorkerConfig = z.input<typeof BrandSettings> & {
  core: CoreClient;
  assets: FetchBinding;
  coreTimeoutMs?: number;
  /** Operational signal only: no visitor identifiers and no change to rendering. */
  onGateFallback?: (operation: "issueHandoff" | "verifyHandoff") => void;
};
export type BrandConfigSource = BrandWorkerConfig | (() => BrandWorkerConfig | Promise<BrandWorkerConfig>);
