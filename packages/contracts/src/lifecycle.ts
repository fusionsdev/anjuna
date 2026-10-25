import { z } from "zod";
import {
  BrandId,
  Hostname,
} from "./common.js";
import { AdminRequestContext, AdminRole, AuditActorRole, AmountBuckets, DrainKey, FormVersion, PrepopBase } from "./admin-api.js";
import { BrandProfile } from "./brand-draft.js";
import { FormRoute, Keyword } from "./runtime-config.js";
import { BrandTheme } from "./theme.js";

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

export const InstallStatus = z.enum(["queued", "running", "ready", "failed", "rolled_back"]);
export type InstallStatus = z.infer<typeof InstallStatus>;

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

/**
 * Isomorphic WebCrypto digests. Cloudflare Workers and Node 20+ both expose
 * `globalThis.crypto.subtle` and `TextEncoder`; the contracts build compiles with `types: []`
 * (no lib.dom or @types/node), so the minimal surface is described here instead.
 */
interface SubtleDigest {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}
interface TextEncoderLike {
  encode(value: string): Uint8Array;
}
const webCrypto = globalThis as unknown as {
  crypto: { subtle: SubtleDigest };
  TextEncoder: new () => TextEncoderLike;
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await webCrypto.crypto.subtle.digest("SHA-256", new webCrypto.TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The immutable install identity the factory's upgrade-all workflow writes for a brand, in the
 * workflow's exact key order. The factory and the panel both derive install IDs from this, so an
 * operator can map each brand's outcome for a past command without re-reading the workflow.
 */
/**
 * The revision ID the workflow's `create_revisions` step inserts for every selected brand before the
 * canary starts. A row with this ID is persisted proof that the brand was selected for this command.
 */
export function upgradeRevisionId(command: UpgradeAllCommand, brandId: string): Promise<string> {
  return sha256Hex(JSON.stringify([
    "revision",
    command.from_template_version_id,
    command.to_template_version_id,
    command.form_artifact_id,
    command.canary_brand_id,
    command.started_by,
    command.started_role,
    brandId,
  ])).then((digest) => `upgrade-revision-${digest}`);
}

export function upgradeInstallId(command: UpgradeAllCommand, brandId: string): Promise<string> {
  return sha256Hex(JSON.stringify([
    "install",
    command.from_template_version_id,
    command.to_template_version_id,
    command.form_artifact_id,
    command.canary_brand_id,
    command.started_by,
    command.started_role,
    brandId,
  ])).then((digest) => `upgrade-install-${digest}`);
}

export const UpgradeAllOutcome = z.strictObject({
  brand_id: BrandId,
  domain: Hostname,
  is_canary: z.boolean(),
  install_id: Id.nullable(),
  // The command's own install row when install_id is a later retry of it.
  retry_of: Id.nullable(),
  status: z.enum(["queued", "running", "ready", "failed", "rolled_back", "skipped"]),
  error: z.string().nullable(),
});
export type UpgradeAllOutcome = z.infer<typeof UpgradeAllOutcome>;

export const LatestUpgradeResponse = z.strictObject({
  upgrade: z.strictObject({
    audit_id: z.number().int(),
    accepted_at: Timestamp,
    command: UpgradeAllCommand,
    outcomes: z.array(UpgradeAllOutcome),
  }).nullable(),
  // Set when the newest upgrade.start audit row cannot be read as a command; `upgrade` is then null.
  command_error: z.strictObject({ audit_id: z.number().int(), message: z.string() }).optional(),
});
export type LatestUpgradeResponse = z.infer<typeof LatestUpgradeResponse>;

export const CoreListErrorCode = z.enum([
  "core_binding_missing",
  "core_list_fetch_failed",
  "core_list_response_invalid",
  "core_list_account_missing",
]);
export type CoreListErrorCode = z.infer<typeof CoreListErrorCode>;

/** A partial core list failure, surfaced to the operator instead of silently hiding core brands. */
export const CoreListError = z.strictObject({
  code: CoreListErrorCode,
  message: z.string().min(1),
});
export type CoreListError = z.infer<typeof CoreListError>;

export const InitialRuntime = z.strictObject({
  drain_key: DrainKey,
  aid: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "Invalid aid"),
  prepop_base: PrepopBase,
  amount_buckets: AmountBuckets,
  form_route: FormRoute,
  keyword_default: Keyword,
  form_version: FormVersion,
  /** The draft's colors (FUS-381), written to brand_runtime.theme_json on first install only. */
  theme: BrandTheme.nullable().optional(),
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

export const AdsRoutingField = z.enum(["google_ads_account", "google_conversion_action", "adkit_project"]);
export type AdsRoutingField = z.infer<typeof AdsRoutingField>;

/**
 * Install step sync_runtime, first install only: the draft's `profile.ads` routing for the drain. Core writes a field only
 * while the brand_runtime column is NULL, so a value the owner set is never overwritten. The conversion action is written
 * only next to its own account (runtime account NULL or equal), so a route never pairs one account with another's action.
 */
export const InstallAdsRoutingRequest = z.strictObject({
  install_id: Id,
  brand_id: BrandId,
  account: Id,
  ads: BrandProfile.shape.ads.unwrap().omit({ microsoft_ads_account: true }),
});
export type InstallAdsRoutingRequest = z.infer<typeof InstallAdsRoutingRequest>;

export const InstallAdsRoutingResponse = z.strictObject({
  /** Fields written by this call. */
  copied: z.array(AdsRoutingField),
  /** Fields the draft set that were not written: brand_runtime already held a value, or the action belongs to another account. */
  kept: z.array(AdsRoutingField),
});
export type InstallAdsRoutingResponse = z.infer<typeof InstallAdsRoutingResponse>;

/** Install step sync_runtime: give the brand its own listmonk list (brand_runtime.listmonk_list_id). Safe to repeat. */
export const InstallMailingListRequest = z.strictObject({ install_id: Id, brand_id: BrandId, account: Id });
export type InstallMailingListRequest = z.infer<typeof InstallMailingListRequest>;

export const InstallMailingListResponse = z.discriminatedUnion("state", [
  z.strictObject({ state: z.enum(["stored", "found", "created"]), list_id: z.number().int().positive() }),
  /** LISTMONK_URL, LISTMONK_USER or LISTMONK_TOKEN is unset in Core: no list, the cron falls back to LISTMONK_LIST_MAP. */
  z.strictObject({ state: z.literal("not_configured"), list_id: z.null() }),
]);
export type InstallMailingListResponse = z.infer<typeof InstallMailingListResponse>;

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
  /** A step that finished but fell back, e.g. the brand's listmonk list could not be created and the tenant list is used. */
  warning: z.string().max(500).optional(),
});

/**
 * What an install row did, as the panel shows it. `installs.kind` has no redeploy value, so a redeploy is stored as
 * `upgrade` and told apart by its revision id (see `installOperation` in the web app).
 */
export const InstallOperation = z.enum(["install", "rollback", "upgrade", "redeploy"]);
export type InstallOperation = z.infer<typeof InstallOperation>;

export const InstallWithReceipts = z.strictObject({
  install_id: Id,
  brand_id: BrandId,
  revision_id: Id.nullable(),
  operation: InstallOperation.optional(),
  status: InstallStatus,
  runtime_sync_status: RuntimeSyncStatus,
  receipts: z.array(InstallReceipt),
  /** The brand holds a retained lock that only Owner Recover can release. */
  recovery_required: z.boolean().optional(),
});
export type InstallWithReceipts = z.infer<typeof InstallWithReceipts>;

// spec brands (FUS-377)
export const LatestInstall = z.strictObject({
  install_id: Id,
  operation: InstallOperation,
  status: InstallStatus,
  started_at: Timestamp,
  finished_at: Timestamp.nullable(),
  started_by: ActorId,
});
export type LatestInstall = z.infer<typeof LatestInstall>;

export const LifecycleBrandSummary = z.strictObject({
  brand_id: BrandId,
  /** Screen name from `brands.name`. Absent for a core-only brand. Rows made before the name field hold a domain-derived name, so it is not held to the create rule. */
  name: z.string().min(1).optional(),
  account: Id,
  hostnames: z.array(Hostname).min(1),
  status: z.union([LifecycleStatus, z.enum(["unmanaged", "paused", "retired"])]),
  current_revision_id: Id.nullable(),
  runtime_sync_status: z.union([RuntimeSyncStatus, z.literal("sync_error")]),
  bundle_form_version: FormVersion.nullable(),
  payload_version: PayloadVersion.nullable(),
  /** The newest registered form artifact the tenant can use, when it is newer than the brand's own. Absent otherwise. */
  newer_form: z.strictObject({ form_artifact_id: Id, bundle_form_version: FormVersion }).optional(),
  /** The brand profile from the latest revision's config_json. Only the single-brand read carries it. */
  profile: BrandProfile.optional(),
  /** The newest install row for the brand. */
  latest_install: LatestInstall.nullable().optional(),
});
export type LifecycleBrandSummary = z.infer<typeof LifecycleBrandSummary>;

// spec brands (FUS-377)
export const DeploySource = z.enum(["install", "audit"]);
export type DeploySource = z.infer<typeof DeploySource>;

export const DeployStatus = z.enum(["queued", "running", "ready", "failed", "rolled_back", "done"]);
export type DeployStatus = z.infer<typeof DeployStatus>;

export const DeployEvent = z
  .strictObject({
    source: DeploySource,
    /** The install id for an install row, `audit-<id>` for an audit row. */
    event_id: Id,
    brand_id: BrandId,
    operation: InstallOperation.nullable(),
    action: z.string().min(1).max(64).nullable(),
    status: DeployStatus,
    from_revision_id: Id.nullable(),
    to_revision_id: Id.nullable(),
    is_canary: z.boolean(),
    started_by: ActorId,
    started_role: AuditActorRole,
    started_at: Timestamp,
    finished_at: Timestamp.nullable(),
    error: z.string().max(500).nullable(),
  })
  .superRefine((event, ctx) => {
    if (event.source === "install") {
      if (event.operation === null) ctx.addIssue({ code: "custom", path: ["operation"], message: "An install row needs an operation" });
      if (event.action !== null) ctx.addIssue({ code: "custom", path: ["action"], message: "An install row has no action" });
      return;
    }
    if (event.operation !== null) ctx.addIssue({ code: "custom", path: ["operation"], message: "An audit row has no operation" });
    if (event.action === null) ctx.addIssue({ code: "custom", path: ["action"], message: "An audit row needs an action" });
    if (event.status !== "done") ctx.addIssue({ code: "custom", path: ["status"], message: "An audit row is always done" });
  });
export type DeployEvent = z.infer<typeof DeployEvent>;

export const DeployHistoryQuery = z.strictObject({
  brand: BrandId.optional(),
  source: DeploySource.optional(),
  status: DeployStatus.optional(),
  operation: InstallOperation.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type DeployHistoryQuery = z.infer<typeof DeployHistoryQuery>;

export const DeployUnavailableSource = z.enum(["core_audit"]);
export type DeployUnavailableSource = z.infer<typeof DeployUnavailableSource>;

export const DeployHistoryResponse = z.strictObject({
  events: z.array(DeployEvent),
  has_more: z.boolean(),
  unavailable: z.array(DeployUnavailableSource),
});
export type DeployHistoryResponse = z.infer<typeof DeployHistoryResponse>;

export const BrandRevision = z.strictObject({
  revision_id: Id,
  revision: z.number().int().positive(),
  template_version_id: Id,
  form_artifact_id: Id,
  bundle_form_version: FormVersion.nullable(),
  worker_version_id: z.string().min(1).max(128).nullable(),
  created_by: ActorId,
  created_at: Timestamp,
  is_current: z.boolean(),
});
export type BrandRevision = z.infer<typeof BrandRevision>;

export const BrandRevisionsResponse = z.strictObject({
  brand_id: BrandId,
  current_revision_id: Id.nullable(),
  rollback_target_revision_id: Id.nullable(),
  revisions: z.array(BrandRevision),
});
export type BrandRevisionsResponse = z.infer<typeof BrandRevisionsResponse>;
