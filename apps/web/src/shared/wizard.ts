/**
 * Shapes the brand wizard shares between the panel Worker (src/server/wizard.ts) and the SPA.
 * Panel-only: none of these are core admin API contracts.
 */
import { BrandName, UpdateBrandDraftRequest, UpdateBrandDraftResponse } from "@anjuna/contracts";
import { z } from "zod";

/** A brand domain: lowercase, no trailing dot, apex (no www). Shared by draft creation, duplicate and the zone check. */
export const DraftDomain = z.string().min(1).max(253).transform((value) => value.toLowerCase().replace(/\.$/, "")).refine((value) => !value.startsWith("www."), "Use the apex domain, not a www hostname").refine((value) => /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}$/.test(value), "Must be a valid apex domain");

/** POST /api/wizard/zone-check. brand_id lets the check ignore records that belong to the draft's own Worker. */
export const ZoneCheckRequest = z.strictObject({ domain: DraftDomain, brand_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional() });
export type ZoneCheckRequest = z.input<typeof ZoneCheckRequest>;

export const ZoneCheckResponse = z.strictObject({
  zone_active: z.boolean(),
  /** The zone covering the domain, null when the tenant Cloudflare account has none. */
  zone_name: z.string().nullable(),
  nameservers: z.array(z.string()),
  conflicting_records: z.array(z.strictObject({ type: z.string(), name: z.string() })),
});
export type ZoneCheckResponse = z.infer<typeof ZoneCheckResponse>;

/** GET /api/wizard/defaults: the tenant values the Review summary shows read-only. */
export const WizardDefaultsResponse = z.strictObject({
  amount_buckets: z.array(z.number()),
  form_route: z.string(),
});
export type WizardDefaultsResponse = z.infer<typeof WizardDefaultsResponse>;

/** POST /api/brands/:id/duplicate. A new domain is required, a name is optional (else derived from the domain). */
export const DuplicateBrandRequest = z.strictObject({ domain: DraftDomain, name: BrandName.optional() });
export type DuplicateBrandRequest = z.input<typeof DuplicateBrandRequest>;

/**
 * GET /api/wizard/drafts/:id and POST /api/brands/:id/duplicate: a draft as the wizard resumes it. A live brand answers
 * with status "live" and its current revision; the wizard then holds its edits in memory and finishes with wizard-redeploy.
 */
export const WizardDraft = UpdateBrandDraftResponse.omit({ changed: true }).extend({
  brand: UpdateBrandDraftResponse.shape.brand.extend({ status: z.enum(["draft", "failed", "live"]) }),
  /** A live brand only: brands.current_revision_id when the wizard opened. wizard-redeploy sends it back as its base. */
  base_revision_id: z.string().min(1).optional(),
});
export type WizardDraft = z.infer<typeof WizardDraft>;

/**
 * POST /api/brands/:id/wizard-redeploy: the edits plus the revision the wizard opened on. The server answers 409
 * stale_revision when base_revision_id is absent or another install moved the brand since, so a second owner cannot
 * overwrite the first one's change. Optional here so a missing base reaches that 409 and not a 422.
 */
export const WizardRedeployRequest = UpdateBrandDraftRequest.extend({ base_revision_id: z.string().min(1).optional() });
export type WizardRedeployRequest = z.infer<typeof WizardRedeployRequest>;

/** POST /api/wizard/preview/:id: a live brand's unsaved template and profile, rendered over its current revision. */
export const WizardPreviewRequest = UpdateBrandDraftRequest.pick({ template_version_id: true, profile: true });
export type WizardPreviewRequest = z.infer<typeof WizardPreviewRequest>;

export const DuplicateBrandResponse = WizardDraft.extend({ duplicated_from: z.string().min(1) });
export type DuplicateBrandResponse = z.infer<typeof DuplicateBrandResponse>;
