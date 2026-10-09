import { z } from "zod";
import {
  BrandId,
  Hostname,
} from "./common.js";
import { AdminRequestContext, AdminRole, AmountBuckets, DrainKey, FormVersion, PrepopBase } from "./admin-api.js";
import { FormRoute, Keyword } from "./runtime-config.js";

const Id = z.string().min(1).max(128);
export const SealedTemplateVersion = z.strictObject({
  template_version_id: Id,
  name: z.string().min(1),
  version: z.number().int().positive(),
  status: z.literal("sealed"),
});
export type SealedTemplateVersion = z.infer<typeof SealedTemplateVersion>;
export const SealedTemplatesResponse = z.strictObject({ templates: z.array(SealedTemplateVersion) });

const ActorId = AdminRequestContext.shape.actor_id;
const Timestamp = z.iso.datetime();
const PayloadVersion = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "Invalid payload version");

const Hostnames = z
  .array(Hostname)
  .min(1)
  .max(2)
  .superRefine((hostnames, ctx) => {
    if (new Set(hostnames).size !== hostnames.length) {
      ctx.addIssue({ code: "custom", message: "Hostnames must be unique" });
      return;
    }
    if (hostnames.length === 1 && hostnames[0]!.startsWith("www.")) {
      ctx.addIssue({ code: "custom", message: "A lone hostname must be the apex" });
      return;
    }
    if (hostnames.length === 2 && hostnames[1] !== `www.${hostnames[0]}`) {
      ctx.addIssue({ code: "custom", message: "Hostnames must be an apex followed by its www hostname" });
    }
  });

export const LifecycleStatus = z.enum(["draft", "installing", "live", "failed", "rolled_back"]);
export type LifecycleStatus = z.infer<typeof LifecycleStatus>;

export const RuntimeSyncStatus = z.enum(["queued", "running", "ready", "failed"]);
export type RuntimeSyncStatus = z.infer<typeof RuntimeSyncStatus>;

const InstallStatus = z.enum(["queued", "running", "ready", "failed", "rolled_back"]);

export const RegisterFormArtifactRequest = z.strictObject({
  form_artifact_id: Id,
  template_version_id: Id,
  git_sha: z.string().regex(/^[0-9a-f]{7,64}$/i, "Invalid git sha"),
  bundle_form_version: FormVersion,
  payload_version: PayloadVersion,
});
export type RegisterFormArtifactRequest = z.infer<typeof RegisterFormArtifactRequest>;

export const BackfillPayloadVersionRequest = z.strictObject({
  form_artifact_id: Id,
  payload_version: PayloadVersion,
});
export type BackfillPayloadVersionRequest = z.infer<typeof BackfillPayloadVersionRequest>;

export const CreateBrandDraftRequest = z.strictObject({
  brand_id: BrandId,
  account: Id,
  hostname: Hostname,
  keyword_default: Keyword,
  template_version_id: Id,
});
export type CreateBrandDraftRequest = z.infer<typeof CreateBrandDraftRequest>;

const StartedBy = z.strictObject({
  started_by: ActorId,
  started_role: AdminRole,
});

export const InstallBrandCommand = z.strictObject({
  install_id: Id,
  brand_id: BrandId,
  revision_id: Id,
  ...StartedBy.shape,
});
export type InstallBrandCommand = z.infer<typeof InstallBrandCommand>;

export const RollbackBrandCommand = z.strictObject({
  install_id: Id,
  brand_id: BrandId,
  to_revision_id: Id.nullable(),
  ...StartedBy.shape,
});
export type RollbackBrandCommand = z.infer<typeof RollbackBrandCommand>;

export const UpgradeAllCommand = z
  .strictObject({
    from_template_version_id: Id,
    to_template_version_id: Id,
    form_artifact_id: Id,
    canary_brand_id: BrandId,
    started_by: Id,
    started_role: z.literal("owner"),
  })
  .refine((c) => c.from_template_version_id !== c.to_template_version_id, {
    message: "Upgrade source and target versions must differ",
    path: ["to_template_version_id"],
  });
export type UpgradeAllCommand = z.infer<typeof UpgradeAllCommand>;

export const InitialRuntime = z.strictObject({
  drain_key: DrainKey,
  aid: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "Invalid aid"),
  prepop_base: PrepopBase,
  amount_buckets: AmountBuckets,
  form_route: FormRoute,
  keyword_default: Keyword,
  form_version: FormVersion,
});
export type InitialRuntime = z.infer<typeof InitialRuntime>;

export const ApplyRuntimeRequest = z.strictObject({
  install_id: Id,
  brand_id: BrandId,
  account: Id,
  hostnames: Hostnames,
  expected_revision_id: Id.nullable(),
  target_revision_id: Id.nullable(),
  actor_id: ActorId,
  actor_role: AdminRole,
  initial_runtime: InitialRuntime.optional(),
  bundle_form_version: FormVersion.optional(),
});
export type ApplyRuntimeRequest = z.infer<typeof ApplyRuntimeRequest>;

export const ApplyRuntimeResponse = z.strictObject({
  state: z.enum(["applied", "detached", "noop"]),
  install_id: Id,
  applied_revision_id: Id.nullable(),
  paused: z.boolean(),
});
export type ApplyRuntimeResponse = z.infer<typeof ApplyRuntimeResponse>;

export const RuntimeStateRequest = z.strictObject({ brand_id: BrandId, account: Id });
export type RuntimeStateRequest = z.infer<typeof RuntimeStateRequest>;

export const RuntimeStateResponse = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("absent"), brand_id: BrandId, account: Id, credential_account_match: z.boolean() }),
  z.strictObject({
    state: z.literal("applied"),
    brand_id: BrandId,
    account: Id,
    applied_revision_id: Id.nullable(),
    last_lifecycle_install_id: Id.nullable(),
    paused: z.boolean(),
    bundle_form_version: FormVersion.nullable(),
    credential_account_match: z.boolean(),
  }),
]);
export type RuntimeStateResponse = z.infer<typeof RuntimeStateResponse>;

export const RuntimeListRequest = z.strictObject({ account: Id });
export type RuntimeListRequest = z.infer<typeof RuntimeListRequest>;
export const RuntimeListResponse = z.object({
  brands: z.array(z.object({ brand_id: BrandId, account: Id, hostnames: z.array(Hostname), applied_revision_id: Id.nullable(), paused: z.boolean(), bundle_form_version: FormVersion.nullable() })),
});
export type RuntimeListResponse = z.infer<typeof RuntimeListResponse>;

export const VerifySoldLeadRequest = z.strictObject({ brand_id: BrandId, lead_id: Id });
export type VerifySoldLeadRequest = z.infer<typeof VerifySoldLeadRequest>;

export const VerifySoldLeadResponse = z.strictObject({
  verified: z.literal(true),
  event_id: Id,
  event_at: Timestamp,
});
export type VerifySoldLeadResponse = z.infer<typeof VerifySoldLeadResponse>;

export const ChecklistItemName = z.enum(["drain_route", "leadsgate_postbacks", "test_sold", "final_url"]);
export type ChecklistItemName = z.infer<typeof ChecklistItemName>;

const ManualChecklistEvidence = z.strictObject({
  brand_id: BrandId,
  item: z.enum(["drain_route", "leadsgate_postbacks", "final_url"]),
  actor_id: ActorId,
  verified_at: Timestamp,
});

const TestSoldChecklistEvidence = z.strictObject({
  brand_id: BrandId,
  item: z.literal("test_sold"),
  actor_id: ActorId,
  verified_at: Timestamp,
  event_id: Id,
});

export const ChecklistEvidence = z.union([ManualChecklistEvidence, TestSoldChecklistEvidence]);
export type ChecklistEvidence = z.infer<typeof ChecklistEvidence>;

export const InstallReceipt = z.strictObject({
  step: z.string().min(1).max(64),
  status: z.enum(["queued", "running", "ready", "failed"]),
  error: z.string().max(500).optional(),
});

export const InstallWithReceipts = z.strictObject({
  install_id: Id,
  brand_id: BrandId,
  revision_id: Id.nullable(),
  status: InstallStatus,
  runtime_sync_status: RuntimeSyncStatus,
  receipts: z.array(InstallReceipt),
});
export type InstallWithReceipts = z.infer<typeof InstallWithReceipts>;

export const LifecycleBrandSummary = z.strictObject({
  brand_id: BrandId,
  account: Id,
  hostnames: z.array(Hostname).min(1),
  status: z.union([LifecycleStatus, z.enum(["unmanaged", "paused", "retired"])]),
  current_revision_id: Id.nullable(),
  runtime_sync_status: z.union([RuntimeSyncStatus, z.literal("sync_error")]),
  bundle_form_version: FormVersion.nullable(),
  payload_version: PayloadVersion.nullable(),
});
export type LifecycleBrandSummary = z.infer<typeof LifecycleBrandSummary>;
