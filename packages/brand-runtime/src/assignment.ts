import type { BrandSettings } from "./config.js";
import { cookie, readCookie } from "./http.js";

export interface Assignment { experiment_id: string | null; variant: string; setCookie?: string }

export function assignVariant(request: Request, settings: BrandSettings): Assignment {
  const experiment = settings.ab_config;
  if (!experiment) return { experiment_id: null, variant: settings.default_variant };
  const existing = readCookie(request, "_ab")?.split(".");
  if (existing?.length === 2 && existing[0] === experiment.experiment_id && experiment.variants.some((v) => v.id === existing[1])) {
    return { experiment_id: experiment.experiment_id, variant: existing[1]! };
  }
  const draw = crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32 * 100;
  let threshold = 0;
  const variant = experiment.variants.find((v) => { threshold += v.weight; return draw < threshold; })!.id;
  return {
    experiment_id: experiment.experiment_id, variant,
    setCookie: cookie("_ab", `${experiment.experiment_id}.${variant}`),
  };
}
