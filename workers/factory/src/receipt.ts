import type { InstallStep } from "@anjuna/factory-db";
import { cleanKeyword, InitialRuntime } from "@anjuna/contracts";

export const INSTALL_MUTATION_STEPS = [
  "validate", "save_rollback", "render", "upload_assets", "upload_script", "deploy",
  "attach_domains", "smoke", "receipt",
] as const;

export interface TenantRuntimeDefaults {
  account: string;
  aid: string;
  prepop_base: string;
  amount_buckets: readonly number[];
  form_route: string;
  keyword_default: string;
  form_version: string;
}

export interface InstallPreflightInput {
  brand_id: string;
  revision: { brand_id: string; template_status: string; worker_version_id: string | null; config?: Record<string, unknown> };
  artifact: { present: boolean; payload_version: string | null; bundle_form_version: string | null };
  tenant: TenantRuntimeDefaults;
  runtime_state: { state: string; credential_account_match: boolean; account?: string };
  employee_override?: Record<string, unknown>;
}

export interface RegisteredFormArtifact {
  r2_key: string;
  payload_version: string | null;
  bundle_form_version: string | null;
}

/** The revision may select an artifact, but never redefine tenant-owned runtime routing. */
export function deriveAuthoritativeRuntime(
  brandId: string,
  tenant: TenantRuntimeDefaults,
  artifact: RegisteredFormArtifact,
): InitialRuntime {
  const bundle = artifact.bundle_form_version;
  if (!bundle) throw new Error("Registered form artifact has no registered bundle form version");
  return InitialRuntime.parse({
    aid: tenant.aid, prepop_base: tenant.prepop_base,
    form_route: tenant.form_route, keyword_default: cleanKeyword(tenant.keyword_default),
    amount_buckets: [...tenant.amount_buckets],
    form_version: bundle,
    drain_key: opaqueHex(brandId),
  });
}

/** A stable routing identifier that cannot reveal the brand id to the drain. */
function opaqueHex(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}${(h1 ^ h2).toString(16).padStart(8, "0")}${(h1 + h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export function deriveTenantRuntime(brandId: string, tenant: TenantRuntimeDefaults): Omit<TenantRuntimeDefaults, "amount_buckets"> & { amount_buckets: number[]; drain_key: string } {
  return { ...tenant, amount_buckets: [...tenant.amount_buckets], drain_key: opaqueHex(brandId) };
}

/**
 * Build the static Worker fallback from the revision's presentation settings and
 * the authoritative tenant runtime snapshot. Runtime routing always wins.
 */
export function assembleBrandConfig(
  revisionConfig: Record<string, unknown>,
  runtime: ReturnType<typeof deriveAuthoritativeRuntime>,
  hostname: string,
): Record<string, unknown> {
  return {
    ...revisionConfig,
    hostname,
    amount_buckets: runtime.amount_buckets,
    formRoute: runtime.form_route,
    form_route: runtime.form_route,
    form_version: runtime.form_version,
    aid: runtime.aid,
    prepop_base: runtime.prepop_base,
    drain_key: runtime.drain_key,
    keyword_default: runtime.keyword_default,
  };
}

export function validateInstallInputs(input: InstallPreflightInput): InstallPreflightInput {
  if (input.revision.brand_id !== input.brand_id) throw new Error("Revision does not belong to brand");
  if (input.revision.template_status !== "sealed") throw new Error("Template version is not sealed");
  if (!input.artifact.present) throw new Error("Form artifact is missing");
  if (input.artifact.payload_version !== "2026-01") throw new Error("Form artifact payload metadata is not verified");
  if (!input.artifact.bundle_form_version) throw new Error("Form artifact bundle form version is not registered");
  if (!/^form@[A-Za-z0-9._-]+$/.test(input.artifact.bundle_form_version)) {
    throw new Error("Registered form bundle version is invalid");
  }
  const config = input.revision.config ?? {};
  if (["amount_buckets", "form_route", "form_version", "aid", "prepop_base"].some((key) => key in config)) {
    throw new Error("Revision cannot override tenant-owned runtime defaults");
  }
  if (!input.runtime_state.credential_account_match) throw new Error("Core credential account mismatch");
  if (!["absent", "applied"].includes(input.runtime_state.state)) throw new Error("Core runtime is not ready");
  if (input.employee_override && Object.keys(input.employee_override).length > 0) {
    throw new Error("Employee/BFF runtime override is not allowed");
  }
  return input;
}

export function installStepOrder(existingInstall: boolean): string[] {
  return existingInstall
    ? [...INSTALL_MUTATION_STEPS.slice(0, 8), "sync_runtime", "receipt"]
    : [...INSTALL_MUTATION_STEPS.slice(0, 6), "provision_runtime", "attach_domains", "smoke", "receipt"];
}

export function shouldMarkReady(evidence: { smoke: boolean; runtime: boolean }): boolean {
  return evidence.smoke && evidence.runtime;
}

export function isInstallMutationAllowed(status: string): boolean {
  return status === "draft" || status === "live" || status === "failed";
}

export type LifecycleOperationDecision = "claim" | "resume" | "reject";

export function lifecycleOperationDecision(
  brandStatus: string,
  activeInstallId: string | null,
  requestedInstallId: string,
): LifecycleOperationDecision {
  if (activeInstallId === requestedInstallId && brandStatus === "installing") return "resume";
  if (activeInstallId === requestedInstallId && isInstallMutationAllowed(brandStatus)) return "claim";
  if (activeInstallId !== null || brandStatus === "installing" || !isInstallMutationAllowed(brandStatus)) return "reject";
  return "claim";
}

export function compensationInstallId(installId: string): string {
  return `compensate-${installId}`;
}

export function isLinkedCompensationInstall(installId: string, originalInstallId: string): boolean {
  return compensationInstallId(originalInstallId) === installId;
}

export function shouldRetainBrandLockOnFailure(mutationStarted: boolean, originalInstallId?: string): boolean {
  return mutationStarted || Boolean(originalInstallId);
}

export async function isQueuedCompensationInstall(db: D1Database, installId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT kind, status FROM installs WHERE install_id = ?",
  ).bind(installId).first<{ kind: string; status: string }>();
  return row?.kind === "rollback" && row.status === "queued" && installId.startsWith("compensate-");
}

export function compensationFailureEvidence(input: {
  original_install_id: string;
  compensation_install_id: string;
  error: string;
  mutation_started: boolean;
}): Record<string, unknown> {
  return {
    ...input,
    recovery_required: true,
    audit_action: "install.compensation_failed",
  };
}

export function rollbackTargetBelongsToBrand(
  revision: { brand_id: string; worker_version_id: string | null }, brandId: string,
): boolean {
  return revision.brand_id === brandId && Boolean(revision.worker_version_id);
}

export interface Receipt {
  status: "ok" | "failed" | "skipped";
  output: Record<string, unknown>;
}

/** Returns the existing receipt for (install_id, step), or null if none. */
export async function getReceipt(db: D1Database, installId: string, step: InstallStep): Promise<Receipt | null> {
  const row = await db
    .prepare("SELECT status, output_json FROM install_receipts WHERE install_id = ? AND step = ?")
    .bind(installId, step)
    .first<{ status: string; output_json: string | null }>();
  if (!row) return null;
  return {
    status: row.status as Receipt["status"],
    output: row.output_json ? (JSON.parse(row.output_json) as Record<string, unknown>) : {},
  };
}

/** Write a receipt row; fails with UNIQUE constraint if a receipt already exists (expected — use getReceipt first). */
export async function saveReceipt(
  db: D1Database,
  installId: string,
  step: InstallStep,
  status: "ok" | "failed" | "skipped",
  output: Record<string, unknown> = {},
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO install_receipts (install_id, step, status, output_json, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(installId, step, status, JSON.stringify(output), new Date().toISOString())
    .run();
}

/**
 * Run `work` with idempotency via install_receipts.
 *
 * If an "ok" receipt already exists, returns its stored output without running work.
 * If work throws, saves a "failed" receipt and re-throws.
 */
export async function withReceipt<T extends Record<string, unknown>>(
  db: D1Database,
  installId: string,
  step: InstallStep,
  work: () => Promise<T>,
): Promise<T> {
  const existing = await getReceipt(db, installId, step);
  if (existing?.status === "ok") return existing.output as T;
  // A failed receipt means this install already broke. A new attempt must use a new install_id.
  if (existing?.status === "failed") throw new Error(String(existing.output?.error ?? "step previously failed"));

  let result: T;
  try {
    result = await work();
  } catch (err) {
    await saveReceipt(db, installId, step, "failed", { error: String(err) });
    throw err;
  }
  await saveReceipt(db, installId, step, "ok", result);
  return result;
}

/** Mark the install row status and set finished_at. */
export async function setInstallStatus(
  db: D1Database,
  installId: string,
  status: "running" | "ready" | "failed" | "rolled_back",
  error?: string,
  brandId?: string,
  options: { retainBrandLock?: boolean; preserveBrandStatus?: boolean; compensationForInstallId?: string } = {},
): Promise<"claimed" | "resumed" | "updated"> {
  const now = new Date().toISOString();
  if (status === "running") {
    if (brandId) {
      const install = await db.prepare("SELECT status FROM installs WHERE install_id = ?")
        .bind(installId).first<{ status: string }>();
      if (install?.status === "running") return "resumed";
      if (install?.status !== "running") {
        const linkedCompensation = options.compensationForInstallId
          ? isLinkedCompensationInstall(installId, options.compensationForInstallId)
          : false;
        if (await isQueuedCompensationInstall(db, installId) && !linkedCompensation) {
          throw new Error("Queued compensation requires its exact original install");
        }
        if (options.compensationForInstallId && !linkedCompensation) {
          throw new Error("Compensation install is not authorized for the original install");
        }
        if (linkedCompensation) {
          const original = await db.prepare(
            "SELECT brand_id, status FROM installs WHERE install_id = ?",
          ).bind(options.compensationForInstallId).first<{ brand_id: string; status: string }>();
          const brand = await db.prepare("SELECT status FROM brands WHERE brand_id = ?")
            .bind(brandId).first<{ status: string }>();
          if (!original || original.brand_id !== brandId || !["failed", "running"].includes(original.status) || brand?.status !== "installing") {
            throw new Error("Compensation install is not authorized for the retained brand lock");
          }
          if (install?.status !== "queued") {
            throw new Error("Compensation install cannot be re-dispatched after it finished");
          }
        }
        const active = await db.prepare(
          "SELECT install_id FROM installs WHERE brand_id = ? AND status IN ('queued', 'running') ORDER BY started_at LIMIT 1",
        ).bind(brandId).first<{ install_id: string }>();
        const brand = await db.prepare("SELECT status FROM brands WHERE brand_id = ?")
          .bind(brandId).first<{ status: string }>();
        const decision = lifecycleOperationDecision(brand?.status ?? "missing", active?.install_id ?? null, installId);
        if (decision === "reject" && !(linkedCompensation && active?.install_id === options.compensationForInstallId)) {
          throw new Error("Brand already has a lifecycle mutation in progress");
        }
        const claimed = await db
          .prepare("UPDATE brands SET status = 'installing', updated_at = ? WHERE brand_id = ? AND status IN ('draft', 'live', 'failed')")
          .bind(now, brandId)
          .run();
        if (!claimed.meta.changes && decision === "claim" && !linkedCompensation) throw new Error("Brand already has a lifecycle mutation in progress");
      }
    }
    await db
      .prepare("UPDATE installs SET status = 'running' WHERE install_id = ?")
      .bind(installId)
      .run();
    return "claimed";
  } else {
    await db
      .prepare("UPDATE installs SET status = ?, error = ?, finished_at = ? WHERE install_id = ?")
      .bind(status, error ?? null, now, installId)
      .run();
    if (brandId && !options.retainBrandLock && !options.preserveBrandStatus) {
      const previous = await db.prepare("SELECT current_revision_id FROM brands WHERE brand_id=?").bind(brandId).first<{ current_revision_id: string | null }>();
      const brandStatus = status === "ready" || status === "rolled_back" || previous?.current_revision_id ? "live" : "failed";
      await db.prepare("UPDATE brands SET status = ?, updated_at = ? WHERE brand_id = ?")
        .bind(brandStatus, now, brandId).run();
    }
    return "updated";
  }
}

/** Reject a queued dispatch without losing the reason that an operator needs to act. */
export async function rejectQueuedInstall(
  db: D1Database,
  installId: string,
  brandId: string,
  reason: string,
  releaseBrandLock = false,
): Promise<void> {
  const now = new Date().toISOString();
  const evidence = { error: reason, actionable: "Wait for the active lifecycle operation to finish, then retry with a new install_id." };
  await db.prepare("UPDATE installs SET status = 'failed', error = ?, finished_at = ? WHERE install_id = ? AND status IN ('queued', 'running')")
    .bind(JSON.stringify(evidence), now, installId).run();
  if (releaseBrandLock) {
    await db.prepare("UPDATE brands SET status = CASE WHEN current_revision_id IS NULL THEN 'failed' ELSE 'live' END, updated_at = ? WHERE brand_id = ? AND status = 'installing'")
      .bind(now, brandId).run();
  }
  await db.prepare("INSERT OR IGNORE INTO install_receipts (install_id, step, status, output_json, created_at) VALUES (?, 'validate', 'failed', ?, ?)")
    .bind(installId, JSON.stringify(evidence), now).run();
  await db.prepare(`INSERT INTO audit_log
    (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
    VALUES ('system', 'system', 'install.rejected', 'install', ?, NULL, ?, ?)`)
    .bind(installId, JSON.stringify({ brand_id: brandId, ...evidence }), now).run();
}
