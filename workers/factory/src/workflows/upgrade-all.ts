import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../env.js";
import { rejectQueuedInstall, setInstallStatus } from "../receipt.js";
import { REMOTE_STEP_RETRY_CONFIG, instanceDispatched } from "../step-receipt.js";

export interface UpgradeAllParams {
  from_template_version_id: string;
  to_template_version_id: string;
  form_artifact_id: string;
  canary_brand_id: string;
  started_by: string;
  started_role: "owner";
}

interface UpgradeTemplate { template_id: string; status: string; }
interface UpgradeArtifact { present: boolean; payload_version: string | null; bundle_form_version: string | null; }

// Workflow instance IDs allow at most 100 chars of [A-Za-z0-9_-]; raw brand/user ids overflow that, so hash the command identity.
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableUpgradeId(kind: string, ...parts: string[]): Promise<string> {
  return `upgrade-${kind}-${await sha256Hex(JSON.stringify([kind, ...parts]))}`;
}

export function upgradeWorkflowId(params: UpgradeAllParams): Promise<string> {
  return stableUpgradeId(
    "workflow",
    params.from_template_version_id,
    params.to_template_version_id,
    params.form_artifact_id,
    params.canary_brand_id,
    params.started_by,
    params.started_role,
  );
}

export function upgradeRevisionId(
  fromTemplateVersionId: string,
  toTemplateVersionId: string,
  formArtifactId: string,
  brandId: string,
  startedBy = "",
  startedRole = "owner",
  canaryBrandId = "",
): Promise<string> {
  return stableUpgradeId("revision", fromTemplateVersionId, toTemplateVersionId, formArtifactId, canaryBrandId, startedBy, startedRole, brandId);
}

export function upgradeInstallId(
  fromTemplateVersionId: string,
  toTemplateVersionId: string,
  formArtifactId: string,
  brandId: string,
  startedBy = "",
  startedRole = "owner",
  canaryBrandId = "",
): Promise<string> {
  return stableUpgradeId("install", fromTemplateVersionId, toTemplateVersionId, formArtifactId, canaryBrandId, startedBy, startedRole, brandId);
}

export interface UpgradeBrandCandidate {
  brand_id: string;
  status: string;
  current_template_version_id: string | null;
}

export function validateUpgradeSelection(input: {
  from_template_version_id: string;
  to_template_version_id: string;
  from_template: UpgradeTemplate;
  to_template: UpgradeTemplate;
  artifact: UpgradeArtifact;
  canary_brand_id: string;
}): void {
  if (input.from_template_version_id === input.to_template_version_id) throw new Error("Upgrade source and target versions must be different");
  if (input.to_template.status !== "sealed") throw new Error("Upgrade target template version is not sealed");
  if (input.from_template.template_id !== input.to_template.template_id) throw new Error("Upgrade target must belong to the same template family");
  if (!input.artifact.present) throw new Error("Form artifact is missing");
  if (input.artifact.payload_version !== "2026-01") throw new Error("Form artifact payload metadata is not verified");
  if (!input.artifact.bundle_form_version || !/^form@[A-Za-z0-9._-]+$/.test(input.artifact.bundle_form_version)) {
    throw new Error("Registered form bundle version is invalid");
  }
}

export function selectUpgradeBrands(candidates: UpgradeBrandCandidate[], fromTemplateVersionId: string, toTemplateVersionId: string, canaryBrandId: string): { canary: string; remaining: string[] } {
  const eligible = candidates.filter((brand) => brand.status === "live" && brand.current_template_version_id === fromTemplateVersionId).map((brand) => brand.brand_id);
  if (!eligible.includes(canaryBrandId)) throw new Error(`Canary brand ${canaryBrandId} is not an eligible live source brand`);
  // Target-version brands are excluded by the source-version predicate above.
  void toTemplateVersionId;
  return { canary: canaryBrandId, remaining: eligible.filter((brandId) => brandId !== canaryBrandId) };
}

export function canaryGate(evidence: { install: string; core: string }): boolean {
  return evidence.install === "ready" && evidence.core === "ready";
}

export function canarySleepStepName(iteration: number): string {
  return `wait_canary_${iteration}`;
}

/**
 * Starts the install Workflow instance of one upgrade install row (canary or bulk). Safe to run again after any earlier attempt:
 * the instance id is the install id, so a create for an id that exists throws instead of starting a second instance.
 *   - Not queued or running (ready, failed, rolled back): nothing to do.
 *   - Running and its instance exists: an earlier attempt dispatched it. Nothing to do.
 *   - Running without an instance: an earlier attempt claimed the install and failed before or during create. Create it.
 *   - Queued: claim it, then create the instance.
 * A create that throws but left the instance behind (the answer was lost) counts as started. Any other failure goes back to the
 * caller to retry, except a brand held by another lifecycle operation, which is rejected at once, and the last attempt, which is
 * rejected too. A rejected install is never one whose instance exists. Returns the error when the install was rejected.
 */
async function startUpgradeInstall(env: Env, install: { install_id: string; brand_id: string; revision_id: string }, attempt: number): Promise<Error | undefined> {
  const { FACTORY: db, INSTALL_WORKFLOW: workflow } = env;
  const { install_id, brand_id, revision_id } = install;
  const existing = await db.prepare("SELECT status FROM installs WHERE install_id = ?").bind(install_id).first<{ status: string }>();
  if (existing?.status !== "queued" && existing?.status !== "running") return undefined;
  let claimed = existing.status === "running";
  if (claimed && await instanceDispatched(workflow, install_id)) return undefined;
  try {
    if (!claimed) {
      await setInstallStatus(db, install_id, "running", undefined, brand_id);
      claimed = true;
    }
    await workflow.create({ id: install_id, params: { install_id, brand_id, revision_id } });
  } catch (error) {
    if (await instanceDispatched(workflow, install_id)) return undefined;
    const held = error instanceof Error && error.message.includes("lifecycle mutation in progress");
    if (!held && attempt <= REMOTE_STEP_RETRY_CONFIG.retries.limit) throw error;
    await rejectQueuedInstall(db, install_id, brand_id, String(error), claimed);
    return error instanceof Error ? error : new Error(String(error));
  }
  return undefined;
}

export class UpgradeAllWorkflow extends WorkflowEntrypoint<Env, UpgradeAllParams> {
  async run(event: WorkflowEvent<UpgradeAllParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    const { FACTORY: db } = this.env;
    const now = new Date().toISOString();

    const { brand_ids } = await step.do("collect_upgrade", async () => {
      const [fromTemplate, toTemplate, artifact] = await Promise.all([
        db.prepare("SELECT template_id, status FROM template_versions WHERE template_version_id = ?").bind(params.from_template_version_id).first<UpgradeTemplate>(),
        db.prepare("SELECT template_id, status FROM template_versions WHERE template_version_id = ?").bind(params.to_template_version_id).first<UpgradeTemplate>(),
        db.prepare("SELECT r2_key, payload_version, bundle_form_version FROM form_artifacts WHERE form_artifact_id = ?").bind(params.form_artifact_id).first<{ r2_key: string | null; payload_version: string | null; bundle_form_version: string | null }>(),
      ]);
      if (!fromTemplate || !toTemplate) throw new Error("Upgrade template version not found");
      validateUpgradeSelection({
        from_template_version_id: params.from_template_version_id,
        to_template_version_id: params.to_template_version_id,
        from_template: fromTemplate,
        to_template: toTemplate,
        artifact: { present: Boolean(artifact?.r2_key), payload_version: artifact?.payload_version ?? null, bundle_form_version: artifact?.bundle_form_version ?? null },
        canary_brand_id: params.canary_brand_id,
      });
      const rows = await db.prepare(
        `SELECT b.brand_id, b.status, r.template_version_id AS current_template_version_id
         FROM brands b JOIN brand_revisions r ON b.current_revision_id = r.revision_id
         WHERE b.status = 'live' AND r.template_version_id IN (?, ?)`,
      ).bind(params.from_template_version_id, params.to_template_version_id).all<UpgradeBrandCandidate>();
      const selection = selectUpgradeBrands(rows.results, params.from_template_version_id, params.to_template_version_id, params.canary_brand_id);
      return { brand_ids: [selection.canary, ...selection.remaining] };
    });

    const { revision_map } = await step.do("create_revisions", async () => {
      const entries: Array<{ brand_id: string; revision_id: string }> = [];
      for (const brand_id of brand_ids) {
        const current = await db.prepare("SELECT revision, config_json FROM brand_revisions WHERE brand_id = ? ORDER BY revision DESC LIMIT 1").bind(brand_id).first<{ revision: number; config_json: string }>();
        if (!current) throw new Error(`Current revision not found for ${brand_id}`);
        const revision_id = await upgradeRevisionId(params.from_template_version_id, params.to_template_version_id, params.form_artifact_id, brand_id, params.started_by, params.started_role, params.canary_brand_id);
        await db.prepare(
          `INSERT OR IGNORE INTO brand_revisions (revision_id, brand_id, revision, template_version_id, form_artifact_id, config_json, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(revision_id, brand_id, current.revision + 1, params.to_template_version_id, params.form_artifact_id, current.config_json, params.started_by, now).run();
        entries.push({ brand_id, revision_id });
      }
      return { revision_map: Object.fromEntries(entries.map((entry) => [entry.brand_id, entry.revision_id])) };
    });

    const canaryInstallId = await upgradeInstallId(params.from_template_version_id, params.to_template_version_id, params.form_artifact_id, params.canary_brand_id, params.started_by, params.started_role, params.canary_brand_id);
    // Retry config equals the engine default, written out so the last attempt is known. A retry or a re-run neither starts a second
    // instance nor rejects one that is running: see startUpgradeInstall. The install row is INSERT OR IGNORE with a deterministic id.
    await step.do("canary_install", REMOTE_STEP_RETRY_CONFIG, async (ctx) => {
      const revision_id = revision_map[params.canary_brand_id];
      if (!revision_id) throw new Error("Canary revision was not created");
      await db.prepare(
         `INSERT OR IGNORE INTO installs (install_id, brand_id, kind, from_revision_id, to_revision_id, is_canary, status, started_by, started_role, started_at)
         SELECT ?, ?, 'upgrade', current_revision_id, ?, 1, 'queued', ?, ?, ? FROM brands WHERE brand_id = ?`,
      ).bind(canaryInstallId, params.canary_brand_id, revision_id, params.started_by, params.started_role, now, params.canary_brand_id).run();
      // A rejected canary is already recorded as failed with its evidence; another attempt would only find it settled.
      const rejected = await startUpgradeInstall(this.env, { install_id: canaryInstallId, brand_id: params.canary_brand_id, revision_id }, ctx.attempt);
      if (rejected) throw new NonRetryableError(rejected.message);
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await step.sleep(canarySleepStepName(i), "10 seconds");
      // Only reads: a retry cannot start anything. The config equals the engine default.
      const evidence = await step.do(`canary_status_${i}`, REMOTE_STEP_RETRY_CONFIG, async () => {
        const status = await db.prepare("SELECT status FROM installs WHERE install_id = ?").bind(canaryInstallId).first<{ status: string }>();
        const core = await db.prepare("SELECT status FROM install_receipts WHERE install_id = ? AND step = 'sync_runtime'").bind(canaryInstallId).first<{ status: string }>();
        return { install: status?.status ?? "missing", core: core?.status === "ok" ? "ready" : core?.status ?? "pending" };
      });
      if (canaryGate(evidence)) { ready = true; break; }
      if (evidence.install === "failed" || evidence.install === "rolled_back") throw new Error(`Canary install failed (status=${evidence.install})`);
    }
    if (!ready) throw new Error("Canary install did not reach READY");

    // A brand whose dispatch can still succeed does not hold the others back: the loop goes on, then the step retries and finds
    // the dispatched ones running with their instances. A brand that is held by another operation, or still fails on the last
    // attempt, is rejected alone, as before, and the step finishes.
    await step.do("bulk_installs", REMOTE_STEP_RETRY_CONFIG, async (ctx) => {
      const remaining = brand_ids.filter((brand_id) => brand_id !== params.canary_brand_id);
      let retry: unknown;
      for (const brand_id of remaining) {
        const revision_id = revision_map[brand_id];
        if (!revision_id) continue;
        const install_id = await upgradeInstallId(params.from_template_version_id, params.to_template_version_id, params.form_artifact_id, brand_id, params.started_by, params.started_role, params.canary_brand_id);
        try {
          await db.prepare(
            `INSERT OR IGNORE INTO installs (install_id, brand_id, kind, from_revision_id, to_revision_id, is_canary, status, started_by, started_role, started_at)
             SELECT ?, ?, 'upgrade', current_revision_id, ?, 0, 'queued', ?, ?, ? FROM brands WHERE brand_id = ?`,
          ).bind(install_id, brand_id, revision_id, params.started_by, params.started_role, new Date().toISOString(), brand_id).run();
          await startUpgradeInstall(this.env, { install_id, brand_id, revision_id }, ctx.attempt);
        } catch (error) {
          retry ??= error;
        }
      }
      if (retry !== undefined) throw retry;
      return { started: remaining.length };
    });
  }
}
