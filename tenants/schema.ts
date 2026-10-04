/**
 * Zod schema for a tenant installation config.
 * Secrets are referenced by their GitHub Actions secret name only — values never appear here.
 */
import { z } from "zod";

const slug = /^[a-z][a-z0-9-]*$/;
const hostname = /^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}$/;
const secretName = /^[A-Z][A-Z0-9_]*$/;

export const TenantSecrets = z.strictObject({
  /** GitHub Actions secret name holding the Cloudflare API token for this tenant's account. */
  cloudflareApiToken: z.string().regex(secretName),
  /** GitHub Actions secret name for BETTER_AUTH_SECRET. */
  betterAuthSecret: z.string().regex(secretName),
  /** GitHub Actions secret name for DRAIN_TOKEN. */
  drainToken: z.string().regex(secretName),
  /** GitHub Actions secret name for the per-brand postback token salt. */
  postbackTokenSalt: z.string().regex(secretName),
});
export type TenantSecrets = z.infer<typeof TenantSecrets>;

export const TenantD1 = z.strictObject({
  leads: z.string().uuid(),
  factory: z.string().uuid(),
  auth: z.string().uuid(),
});
export type TenantD1 = z.infer<typeof TenantD1>;

export const TenantConfig = z.strictObject({
  /** Unique lowercase slug, e.g. `"aduplift"` or `"maimax"`. Used as a name prefix for resources. */
  name: z.string().regex(slug, "slug: lowercase, hyphens OK, must start with letter"),
  /** Cloudflare account ID for this tenant. Account IDs are not secrets. */
  accountId: z.string().length(32, "Cloudflare account IDs are 32 hex characters"),
  /** Hostname of the core Worker, e.g. `"core.aduplift.ai"`. */
  coreDomain: z.string().regex(hostname, "must be a valid lowercase hostname"),
  /** Hostname of the control panel Worker, e.g. `"app.aduplift.ai"`. */
  appDomain: z.string().regex(hostname, "must be a valid lowercase hostname"),
  /** LeadsGate affiliate ID for this tenant's brands. */
  leadsGateAid: z.string().min(1),
  /** LeadsGate prepop base URL, e.g. `"https://go.personalloanpro.com/aff_c"`. */
  prepopBase: z.string().url(),
  /** Drain (AdKit) endpoint URL for conversion uploads. */
  drainUrl: z.string().url(),
  /** Listmonk base URL (optional — mailing cron skips until set). */
  listmonkUrl: z.string().url().optional(),
  /** Alert channel identifier (optional — alerts cron skips until set). */
  alertChannel: z.string().min(1).optional(),
  /** GitHub Actions secret names for this tenant. Values never stored here. */
  secrets: TenantSecrets,
  /** Owner login email seeded on bootstrap. */
  ownerEmail: z.string().email(),
  /**
   * D1 database IDs — set after `bun run bootstrap --tenant <name>` creates them.
   * Omitted until bootstrap runs; placeholder `"00000000-0000-0000-0000-000000000000"` rejected.
   */
  d1: TenantD1.optional(),
  /** R2 bucket name for sealed template artifacts. */
  r2Templates: z.string().min(1).optional(),
});
export type TenantConfig = z.infer<typeof TenantConfig>;
