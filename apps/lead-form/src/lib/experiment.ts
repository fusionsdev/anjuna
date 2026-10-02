// A/B variant for this visitor (FO-3, BR-9).
//
// The arm is assigned SERVER-SIDE by the brand Worker (weighted draw from the brand config,
// sticky first-party cookie with experiment_id) and written into the runtime config as
// `cfg.variant`. The bundle never draws a random number and never stores an assignment of its
// own: the arm follows the server's record of the visit, not the browser's storage.
//
// When the config carries no variant, or one this bundle does not know, the visitor gets
// lite_v1 — the arm V1 serves to 100% of traffic today (owner decision 2026-09-09) — and the
// source is recorded as "fallback" so such sessions can be told apart in reporting.

import { RUNTIME_CONFIG } from "./runtime-config";

export const VARIANTS = {
  // The 14-step incumbent. Any form_variant other than "lite_v1" gets the full, strict
  // validation in core, exactly as V1 does.
  FULL: "full_v1",
  LITE: "lite_v1",
} as const;

export type Variant = (typeof VARIANTS)[keyof typeof VARIANTS];

export type Source = "server" | "fallback";

const ALIASES: Record<string, Variant> = {
  lite: VARIANTS.LITE,
  lite_v1: VARIANTS.LITE,
  full: VARIANTS.FULL,
  full_v1: VARIANTS.FULL,
};

/** Map a raw cfg.variant value onto a known arm. Pure; exported for tests. */
export function variantFromConfig(raw: string | undefined | null): { variant: Variant; source: Source } {
  const key = (raw ?? "").trim().toLowerCase();
  const hit = key ? ALIASES[key] : undefined;
  return hit ? { variant: hit, source: "server" } : { variant: VARIANTS.LITE, source: "fallback" };
}

// Resolved once at module load so the arm cannot change mid-application.
const RESOLVED = variantFromConfig(RUNTIME_CONFIG.variant);

/** The arm for this visitor, as assigned by the brand Worker. */
export function resolveVariant(): Variant {
  return RESOLVED.variant;
}

/** "server" when cfg.variant named a known arm; "fallback" when the default was used. */
export function getAssignmentSource(): Source {
  return RESOLVED.source;
}

export function isLite(): boolean {
  return resolveVariant() === VARIANTS.LITE;
}
