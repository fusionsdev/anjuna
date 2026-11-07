/**
 * AdKit directory and job queue (panel redesign T9, ADR-0005). Workers never call AdKit.
 *
 * VPS routes on core, drain token in the `Authorization` header only:
 *   POST /api/adkit/directory/ingest  hourly snapshot of projects, accounts and conversion actions
 *   GET  /api/adkit/jobs/pending      jobs the executor may claim now
 *   POST /api/adkit/jobs/claim        claim one job (atomic; two claims, one wins)
 *   POST /api/adkit/jobs/result       the job's result or its error
 *
 * Admin routes (owner) are in admin-api.ts: the three directory reads and POST /admin/adkit/jobs.
 */
import { z } from "zod";
import { AdkitProject, BrandId, GoogleAdsAccount, GoogleConversionAction } from "./common.js";
import { ConversionName } from "./conversion-setup.js";

const Timestamp = z.iso.datetime();

/** Directory rows older than this are not served: the panel shows "—" (ADR-0005 decision 10). */
export const ADKIT_DIRECTORY_STALE_MS = 2 * 60 * 60 * 1000;
/** A claim older than this is a crashed executor run and may be claimed again. */
export const ADKIT_JOB_LEASE_MS = 30 * 60 * 1000;
/** Claims per job. A job that fails or crashes this many times stays failed. */
export const ADKIT_JOB_MAX_ATTEMPTS = 5;
/** Most items one directory ingest accepts; the sync script sends larger snapshots in chunks. */
export const ADKIT_DIRECTORY_INGEST_MAX = 1000;

/** Wait before the next claim after the `attempts`-th failed claim: 1 h, 2 h, 4 h ... capped at 24 h. */
export function adkitJobBackoffMs(attempts: number): number {
  const hour = 60 * 60 * 1000;
  return Math.min(2 ** Math.max(attempts - 1, 0) * hour, 24 * hour);
}

export const AdkitDirectoryKind = z.enum(["project", "account", "conversion_action"]);
export type AdkitDirectoryKind = z.infer<typeof AdkitDirectoryKind>;

const DirectoryName = z.string().trim().min(1).max(200);
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "Invalid currency");

/** One directory row as the VPS posts it. The id and parent formats depend on the kind. */
export const AdkitDirectoryIngestItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project"), id: AdkitProject, parent_id: z.null(), name: DirectoryName, currency: z.null() }),
  z.strictObject({
    kind: z.literal("account"), id: GoogleAdsAccount, parent_id: AdkitProject.nullable(), name: DirectoryName,
    currency: CurrencyCode.nullable(),
  }),
  z.strictObject({
    kind: z.literal("conversion_action"), id: GoogleConversionAction, parent_id: GoogleAdsAccount, name: DirectoryName,
    currency: z.null(),
  }),
]);
export type AdkitDirectoryIngestItem = z.infer<typeof AdkitDirectoryIngestItem>;

export const AdkitDirectoryIngestRequest = z.strictObject({
  items: z.array(AdkitDirectoryIngestItem).min(1).max(ADKIT_DIRECTORY_INGEST_MAX),
});
export type AdkitDirectoryIngestRequest = z.infer<typeof AdkitDirectoryIngestRequest>;

export const AdkitDirectoryIngestResponse = z.strictObject({ status: z.literal("ok"), upserted: z.number().int().min(0) });
export type AdkitDirectoryIngestResponse = z.infer<typeof AdkitDirectoryIngestResponse>;

export const AdkitDirectoryItem = z.strictObject({
  id: z.string(),
  name: z.string(),
  currency: CurrencyCode.nullable(),
  updated_at: Timestamp,
});
export type AdkitDirectoryItem = z.infer<typeof AdkitDirectoryItem>;

/** Fresh rows only. `synced_at` is the newest updated_at served, null when nothing is fresh. */
export const AdkitDirectoryResponse = z.strictObject({
  items: z.array(AdkitDirectoryItem),
  synced_at: Timestamp.nullable(),
});
export type AdkitDirectoryResponse = z.infer<typeof AdkitDirectoryResponse>;

export const AdkitJobKind = z.enum(["conversion_action.create"]);
export type AdkitJobKind = z.infer<typeof AdkitJobKind>;

export const AdkitJobStatus = z.enum(["queued", "claimed", "done", "failed"]);
export type AdkitJobStatus = z.infer<typeof AdkitJobStatus>;

/** What the executor needs to create the action. The name is opaque and fixed per job, so a retry adopts it. */
export const ConversionActionCreatePayload = z.strictObject({
  brand_draft_id: BrandId,
  account: GoogleAdsAccount,
  project: AdkitProject.nullable(),
  name: ConversionName,
});
export type ConversionActionCreatePayload = z.infer<typeof ConversionActionCreatePayload>;

export const ConversionActionCreateResult = z.strictObject({
  conversion_action_id: GoogleConversionAction,
  name: ConversionName,
  adopted: z.boolean(),
});
export type ConversionActionCreateResult = z.infer<typeof ConversionActionCreateResult>;

export const AdkitJobError = z.strictObject({ error: z.string().min(1).max(500) });

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9:._-]{8,160}$/, "Invalid idempotency_key");

/** POST /admin/adkit/jobs. Without a key, core derives `<kind>:<brand_draft_id>`. */
export const AdkitJobCreateRequest = z.strictObject({
  kind: AdkitJobKind,
  brand_draft_id: BrandId,
  idempotency_key: IdempotencyKey.optional(),
});
export type AdkitJobCreateRequest = z.infer<typeof AdkitJobCreateRequest>;

export const AdkitJob = z.strictObject({
  id: z.string().uuid(),
  kind: AdkitJobKind,
  status: AdkitJobStatus,
  payload: ConversionActionCreatePayload,
  result: z.union([ConversionActionCreateResult, AdkitJobError]).nullable(),
  attempts: z.number().int().min(0),
  idempotency_key: z.string(),
  requested_by: z.string(),
  next_attempt_at: Timestamp.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type AdkitJob = z.infer<typeof AdkitJob>;

/** `created` is false when the idempotency key already had a row: the body is that row's current state. */
export const AdkitJobCreateResponse = z.strictObject({ job: AdkitJob, created: z.boolean() });
export type AdkitJobCreateResponse = z.infer<typeof AdkitJobCreateResponse>;

const ExecutorJob = z.strictObject({
  id: z.string().uuid(),
  kind: AdkitJobKind,
  payload: ConversionActionCreatePayload,
  attempts: z.number().int().min(0),
});

export const AdkitJobsPendingResponse = z.strictObject({ jobs: z.array(ExecutorJob) });
export type AdkitJobsPendingResponse = z.infer<typeof AdkitJobsPendingResponse>;

export const AdkitJobClaimRequest = z.strictObject({ job_id: z.string().uuid() });
export type AdkitJobClaimRequest = z.infer<typeof AdkitJobClaimRequest>;

export const AdkitJobClaimResponse = z.strictObject({
  status: z.literal("claimed"),
  claim_id: z.string().uuid(),
  job: ExecutorJob,
});
export type AdkitJobClaimResponse = z.infer<typeof AdkitJobClaimResponse>;

/**
 * Exactly one of `result` or `error`. `retryable: false` fails the job at once (for example a command outside
 * the executor allowlist); otherwise it is queued again after the backoff while attempts are left.
 */
export const AdkitJobResultRequest = z.union([
  z.strictObject({ job_id: z.string().uuid(), claim_id: z.string().uuid(), result: ConversionActionCreateResult }),
  z.strictObject({
    job_id: z.string().uuid(), claim_id: z.string().uuid(), error: z.string().min(1).max(500), retryable: z.boolean().optional(),
  }),
]);
export type AdkitJobResultRequest = z.infer<typeof AdkitJobResultRequest>;
