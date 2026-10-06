import type { InstallStep } from "@anjuna/factory-db";

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
  revision: { brand_id: string; template_status: string; worker_version_id: string | null };
  artifact: { present: boolean; payload_version: string | null };
  tenant: TenantRuntimeDefaults;
  runtime_state: { state: string; credential_account_match: boolean; account?: string };
  employee_override?: Record<string, unknown>;
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

export function validateInstallInputs(input: InstallPreflightInput): InstallPreflightInput {
  if (input.revision.brand_id !== input.brand_id) throw new Error("Revision does not belong to brand");
  if (input.revision.template_status !== "sealed") throw new Error("Template version is not sealed");
  if (!input.artifact.present) throw new Error("Form artifact is missing");
  if (input.artifact.payload_version !== "2026-01") throw new Error("Form artifact payload metadata is not verified");
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

export function compensationInstallId(installId: string): string {
  return `compensate-${installId}`;
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
): Promise<void> {
  const now = new Date().toISOString();
  if (status === "running") {
    if (brandId) {
      const install = await db.prepare("SELECT status FROM installs WHERE install_id = ?")
        .bind(installId).first<{ status: string }>();
      if (install?.status !== "running") {
        const claimed = await db
          .prepare("UPDATE brands SET status = 'installing', updated_at = ? WHERE brand_id = ? AND status IN ('draft', 'live', 'failed')")
          .bind(now, brandId)
          .run();
        if (!claimed.meta.changes) throw new Error("Brand already has a lifecycle mutation in progress");
      }
    }
    await db
      .prepare("UPDATE installs SET status = 'running' WHERE install_id = ?")
      .bind(installId)
      .run();
  } else {
    await db
      .prepare("UPDATE installs SET status = ?, error = ?, finished_at = ? WHERE install_id = ?")
      .bind(status, error ?? null, now, installId)
      .run();
    if (brandId) {
      const brandStatus = status === "ready" ? "live" : status === "rolled_back" ? "live" : "failed";
      await db.prepare("UPDATE brands SET status = ?, updated_at = ? WHERE brand_id = ?")
        .bind(brandStatus, now, brandId).run();
    }
  }
}
