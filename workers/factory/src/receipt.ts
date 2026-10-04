import type { InstallStep } from "@anjuna/factory-db";

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
): Promise<void> {
  const now = new Date().toISOString();
  if (status === "running") {
    await db
      .prepare("UPDATE installs SET status = 'running' WHERE install_id = ?")
      .bind(installId)
      .run();
  } else {
    await db
      .prepare("UPDATE installs SET status = ?, error = ?, finished_at = ? WHERE install_id = ?")
      .bind(status, error ?? null, now, installId)
      .run();
  }
}
