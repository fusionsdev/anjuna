import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { CfError } from "./cf-api.js";
import { CoreLifecycleError } from "./core-lifecycle-client.js";
import { getReceipt, saveReceipt, stepErrorMessage, storedErrorMessage } from "./receipt.js";
import type { InstallStep } from "@anjuna/factory-db";

// Transient validate failures (5xx, 408, 429, network, D1) retry 3 times after 5, 10 and 20 s, instead of
// the Workflows default of 5 retries over 310 s. Deterministic failures skip every retry: see failFast.
export const VALIDATE_RETRY_CONFIG = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "60 seconds",
} satisfies WorkflowStepConfig;

// Steps that only touch D1 and R2 retry a transient failure 3 times after 5, 10 and 20 s, like validate.
export const LOCAL_STEP_RETRY_CONFIG = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } } satisfies WorkflowStepConfig;
// Steps that call Cloudflare or Core keep the Workflows default of 5 retries after 10, 20, 40, 80 and 160 s, written out
// because receiptInRetriedStep must know which attempt is the last. Every call they make is safe to repeat: see each step.
export const REMOTE_STEP_RETRY_CONFIG = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } } satisfies WorkflowStepConfig;

/**
 * Turns a failure that the same input always repeats into a NonRetryableError, so the step settles at
 * once: unparsable JSON, a zone that is absent or inactive, Cloudflare or Core 4xx other than 408 and 429.
 * Everything else is rethrown unchanged and keeps the step retries. The message is never altered.
 */
export async function failFast<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const deterministic = err instanceof SyntaxError || (err instanceof Error && err.name === "ZodError") || ((err instanceof CfError || err instanceof CoreLifecycleError) && err.deterministic);
    throw deterministic ? new NonRetryableError((err as Error).message) : err;
  }
}

/**
 * withReceipt for a step with its own retry config (every install and rollback step), run inside step.do so its D1 reads and
 * writes are retried with the step. An ok receipt short-circuits. A failed receipt is saved only when no retry
 * is left (a NonRetryableError or the last attempt), because withReceipt rethrows a stored failure and would
 * defeat every retry. Receipt contents match withReceipt: `{ error: message }` on failure, the step output on success.
 */
export async function receiptInRetriedStep<T extends Record<string, unknown>>(
  db: D1Database, installId: string, step: InstallStep, retryLimit: number, attempt: number, work: () => Promise<T>,
): Promise<T> {
  const existing = await getReceipt(db, installId, step);
  if (existing?.status === "ok") return existing.output as T;
  if (existing?.status === "failed") {
    const stored = String(existing.output?.error ?? "step previously failed");
    throw new NonRetryableError(storedErrorMessage(stored));
  }
  let result: T;
  try {
    result = await work();
  } catch (err) {
    if (err instanceof NonRetryableError || attempt > retryLimit) {
      await saveReceipt(db, installId, step, "failed", { error: stepErrorMessage(err) });
    }
    throw err;
  }
  await saveReceipt(db, installId, step, "ok", result);
  return result;
}

/** receiptInRetriedStep with the step's retry config and failFast: the receipt rule every install and rollback step except install's validate and smoke shares. */
export function stepReceipt<T extends Record<string, unknown>>(
  db: D1Database, installId: string, step: InstallStep, config: { retries: { limit: number } }, ctx: { attempt: number }, work: () => Promise<T>,
): Promise<T> {
  return receiptInRetriedStep(db, installId, step, config.retries.limit, ctx.attempt, () => failFast(work));
}

/** True when the Workflow instance exists: an earlier attempt of the step that dispatches it created it. A duplicate create throws instead of starting a second instance. */
export async function instanceDispatched(workflow: Workflow, instanceId: string): Promise<boolean> {
  try {
    await workflow.get(instanceId);
    return true;
  } catch {
    return false;
  }
}
