import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { attachCustomDomain, deployScript, detachCustomDomain, listCustomDomains } from "../cf-api.js";
import { NonRetryableError } from "cloudflare:workflows";
import { compensationFailureEvidence, rollbackFailureEvidence, setInstallStatus, shouldRetainBrandLockOnFailure, stepErrorText } from "../receipt.js";
import { rollbackTargetBelongsToBrand } from "../receipt.js";
import { CoreLifecycleClient } from "../core-lifecycle-client.js";
import { REMOTE_STEP_RETRY_CONFIG, LOCAL_STEP_RETRY_CONFIG, VALIDATE_RETRY_CONFIG, stepReceipt } from "../step-receipt.js";
import type { Env } from "../env.js";

export interface RollbackParams {
  install_id: string;
  brand_id: string;
  /** null means first-ever install failed before Custom Domains were attached: just mark brand failed. */
  to_revision_id: string | null;
  /** Set only for automatic compensation; the original install is finalized here. */
  original_install_id?: string;
}

interface BrandRow {
  account: string;
  domain: string;
  current_revision_id: string | null;
}

interface RevisionRow {
  brand_id: string;
  worker_version_id: string | null;
}

/**
 * FA-2: Rollback a brand to a previous revision.
 *
 * If to_revision_id is null, the brand never deployed successfully:
 * detach any Custom Domains that were attached and mark brand failed.
 * Otherwise, redeploy the previous Worker version and update the revision pointer.
 */
export class RollbackBrandWorkflow extends WorkflowEntrypoint<Env, RollbackParams> {
  async run(event: WorkflowEvent<RollbackParams>, step: WorkflowStep): Promise<void> {
    const { install_id, original_install_id, brand_id, to_revision_id } = event.payload;
    const { FACTORY: db, CF_ACCOUNT_ID, CF_API_TOKEN } = this.env;
    const terminal = await db.prepare("SELECT status FROM installs WHERE install_id = ?").bind(install_id).first<{ status: string }>();
    if (terminal?.status === "rolled_back" && !original_install_id) return;
    if (terminal?.status === "rolled_back" && original_install_id) {
      const original = await db.prepare("SELECT status FROM installs WHERE install_id = ?").bind(original_install_id).first<{ status: string }>();
      if (original?.status === "rolled_back") return;
    }
    let mutationStarted = false;

    if (terminal?.status !== "rolled_back") await step.do("claim_rollback", () => setInstallStatus(db, install_id, "running", undefined, brand_id, original_install_id
      ? { compensationForInstallId: original_install_id }
      : {}));

    try {
      // Every receipt step below follows the install Workflow's rule (stepReceipt): the receipt read and write sit inside the retried
      // step, the ok receipt comes last, and a failed one is stored only for a NonRetryableError or the last attempt. A failure that the
      // same input always repeats (Cloudflare or Core 4xx other than 408 and 429, a row that is missing) settles at once; the rest
      // retries. Re-running a step after its work succeeded but its ok receipt write failed is safe, with the cost noted on each step.
      // ── Step 1: Validate ───────────────────────────────────────────────────
      // Re-run: reads the brand row and looks the zone up again.
      const { zone_id, domain, hostnames: cachedHostnames, account, current_revision_id } = await step.do("validate", VALIDATE_RETRY_CONFIG, async (ctx) => {
        return stepReceipt(db, install_id, "validate", VALIDATE_RETRY_CONFIG, ctx, async () => {
          const brand = await db
            .prepare("SELECT domain, account, current_revision_id FROM brands WHERE brand_id = ?")
            .bind(brand_id)
            .first<BrandRow>();
          if (!brand) throw new NonRetryableError(`Brand ${brand_id} not found`);

          const { getZone, brandHostnames } = await import("../cf-api.js");
          const zone = await getZone(CF_API_TOKEN, brand.domain);
          return {
            zone_id: zone.id, domain: brand.domain,
            hostnames: brandHostnames(brand.domain, zone.name),
            account: brand.account, current_revision_id: brand.current_revision_id,
          };
        });
      });
      // A Workflow replaying a rollback started before per-zone hostnames has a cached
      // validate output without them; keep the apex plus www pair those runs used.
      const hostnames = cachedHostnames ?? [domain, `www.${domain}`];

      if (!to_revision_id) {
        mutationStarted = true;
        // ── First-install rollback: detach domains ─────────────────────────
        // Re-run: lists what is still attached and detaches only that, so a domain is never deleted twice. After a pass that
        // succeeded the list is empty, and the receipt then counts only the detaches of the pass that wrote it.
        await step.do("attach_domains", REMOTE_STEP_RETRY_CONFIG, async (ctx) => {
          return stepReceipt(db, install_id, "attach_domains", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
            // Find any domain records we may have attached and remove them.
            const existing = await listCustomDomains(CF_API_TOKEN, CF_ACCOUNT_ID, zone_id, `brand-${brand_id}`);
            await Promise.all(
              existing.map((d) => {
                mutationStarted = true;
                return detachCustomDomain(CF_API_TOKEN, CF_ACCOUNT_ID, d.id);
              }),
            );
            return { detached: existing.length };
          });
        });

        // Re-run: Core answers a repeated install_id with a noop and changes nothing (workers/core/src/lifecycle.ts, applyRuntime).
        await step.do("sync_runtime", REMOTE_STEP_RETRY_CONFIG, async (ctx) => stepReceipt(db, install_id, "sync_runtime", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
          const client = new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN);
          const current = await client.runtimeState({ brand_id, account });
          if (current.state === "absent") return { state: "absent", paused: false };
          mutationStarted = true;
          const result = await client.applyRuntime({
            install_id, brand_id, account, hostnames,
            expected_revision_id: current.applied_revision_id, target_revision_id: null,
            actor_id: "system", actor_role: "owner",
          });
          const state = await client.runtimeState({ brand_id, account });
          if (state.state !== "applied" || !state.paused) throw new Error("Core runtime did not pause during detach");
          return result;
        }));

        // Re-run: sets the same brand columns again; only updated_at moves.
        await step.do("receipt", LOCAL_STEP_RETRY_CONFIG, async (ctx) => {
          return stepReceipt(db, install_id, "receipt", LOCAL_STEP_RETRY_CONFIG, ctx, async () => {
            if (!original_install_id) await db
              .prepare("UPDATE brands SET status = 'failed', current_revision_id = NULL, updated_at = ? WHERE brand_id = ?")
              .bind(new Date().toISOString(), brand_id)
              .run();
            return { rolled_back_to: null, detached: true };
          });
        });
      } else {
        mutationStarted = true;
        // ── Standard rollback: redeploy previous version ───────────────────
        // Re-run: POSTs the same older Worker version at 100% again. The version already serves all traffic, so only the
        // deployment history gains one entry.
        const { worker_version_id, bundle_form_version } = await step.do("deploy", REMOTE_STEP_RETRY_CONFIG, async (ctx) => {
          return stepReceipt(db, install_id, "deploy", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
            const revision = await db
              .prepare("SELECT brand_id, worker_version_id FROM brand_revisions WHERE revision_id = ?")
              .bind(to_revision_id)
              .first<RevisionRow>();
            if (!revision || !rollbackTargetBelongsToBrand(revision, brand_id)) throw new NonRetryableError(`Revision ${to_revision_id} is not a deployed revision for this brand`);

            const artifact = await db.prepare("SELECT f.bundle_form_version FROM form_artifacts f JOIN brand_revisions r ON r.form_artifact_id = f.form_artifact_id WHERE r.revision_id = ?")
              .bind(to_revision_id).first<{ bundle_form_version: string | null }>();
            if (!artifact?.bundle_form_version) throw new NonRetryableError("Rollback bundle identity is missing");
            const scriptName = `brand-${brand_id}`;
            mutationStarted = true;
            await deployScript(CF_API_TOKEN, CF_ACCOUNT_ID, scriptName, revision.worker_version_id!);
            return { worker_version_id: revision.worker_version_id!, bundle_form_version: artifact.bundle_form_version };
          });
        });

        // Re-run: Core answers a repeated install_id with a noop and changes nothing (workers/core/src/lifecycle.ts, applyRuntime).
        // The expected revision is read again, but Core checks the install_id first, so a revision that moved is not a conflict.
        await step.do("sync_runtime", REMOTE_STEP_RETRY_CONFIG, async (ctx) => stepReceipt(db, install_id, "sync_runtime", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
          const client = new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN);
          const current = await client.runtimeState({ brand_id, account });
          // A pure function of the Core state just read: another attempt reads the same.
          if (current.state !== "applied") throw new NonRetryableError("Core runtime is missing during rollback");
          mutationStarted = true;
          const result = await client.applyRuntime({
            install_id, brand_id, account, hostnames,
            expected_revision_id: original_install_id ? current.applied_revision_id : current_revision_id, target_revision_id: to_revision_id,
            bundle_form_version,
            actor_id: "system", actor_role: "owner",
          });
          await client.verifyRuntime(brand_id, account, to_revision_id, install_id);
          return result;
        }));

        // Ensure Custom Domains still point to this script (they survive version deploys, but re-attach in case).
        // Re-run: the Workers Domains PUT attaches a hostname to the same script again, as this step already does on hostnames that are attached.
        await step.do("attach_domains", REMOTE_STEP_RETRY_CONFIG, async (ctx) => {
          return stepReceipt(db, install_id, "attach_domains", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
            const scriptName = `brand-${brand_id}`;
            mutationStarted = true;
            const attached = await Promise.all(
              hostnames.map((hostname) => attachCustomDomain(CF_API_TOKEN, CF_ACCOUNT_ID, zone_id, hostname, scriptName)),
            );
            return {
              apex_domain_id: attached[0]!.id,
              ...(attached[1] ? { www_domain_id: attached[1].id } : {}),
            };
          });
        });

        // Re-run: sets the same brand columns again; only updated_at moves.
        await step.do("receipt", LOCAL_STEP_RETRY_CONFIG, async (ctx) => {
          return stepReceipt(db, install_id, "receipt", LOCAL_STEP_RETRY_CONFIG, ctx, async () => {
            if (!original_install_id) await db
              .prepare("UPDATE brands SET status = 'live', current_revision_id = ?, updated_at = ? WHERE brand_id = ?")
              .bind(to_revision_id, new Date().toISOString(), brand_id)
              .run();
            return { rolled_back_to: to_revision_id, worker_version_id };
          });
        });
      }

      // Re-run of a compensation: its batch is one transaction, so an original install that is already rolled back means an earlier attempt
      // committed and only its answer was lost. Running the batch again would add a second audit row and, if another install took the freed
      // brand in the meantime, overwrite that install's lock. A manual rollback re-runs two plain UPDATEs to the same values and has no such marker.
      // The step config equals the engine default; it is written out so the retries are explicit.
      await step.do("finish_rollback", REMOTE_STEP_RETRY_CONFIG, async () => {
        if (!original_install_id) await setInstallStatus(db, install_id, "rolled_back", undefined, brand_id, { preserveBrandStatus: !to_revision_id });
        if (original_install_id) {
          const finished = await db.prepare("SELECT status FROM installs WHERE install_id = ?").bind(original_install_id).first<{ status: string }>();
          if (finished?.status === "rolled_back") return;
          const evidence = {
            original_install_id,
            compensation_install_id: install_id,
            restored_to_revision_id: to_revision_id,
            final_verification: "passed",
          };
          const now = new Date().toISOString();
          // Release the retained lock only with durable completion evidence.
          await db.batch([
            db.prepare("UPDATE installs SET status = 'rolled_back', error = NULL, finished_at = ? WHERE install_id IN (?, ?)")
              .bind(now, original_install_id, install_id),
            db.prepare("UPDATE brands SET status=?, current_revision_id=?, updated_at=? WHERE brand_id=?")
              .bind(to_revision_id ? "live" : "failed", to_revision_id, now, brand_id),
            db.prepare("INSERT OR IGNORE INTO install_receipts (install_id, step, status, output_json, created_at) VALUES (?, 'rollback', 'ok', ?, ?)")
              .bind(original_install_id, JSON.stringify(evidence), now),
            db.prepare(`INSERT INTO audit_log
            (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
            VALUES ('system', 'system', 'install.compensation_succeeded', 'install', ?, NULL, ?, ?)`)
              .bind(original_install_id, JSON.stringify(evidence), now),
          ]);
        }
      });
    } catch (err) {
      // The engine prefixes a NonRetryableError message with its name: the stored text keeps reading "Error: <message>".
      const message = stepErrorText(err);
      await setInstallStatus(db, install_id, "failed", message, brand_id, {
        retainBrandLock: shouldRetainBrandLockOnFailure(mutationStarted, original_install_id),
      });
      if (!original_install_id && mutationStarted) {
        // Retry cannot claim the retained lock, so record evidence for Owner Recover.
        const evidence = rollbackFailureEvidence({ original_install_id: install_id, error: message, mutation_started: true });
        const now = new Date().toISOString();
        await db.batch([
          db.prepare("UPDATE installs SET error = ? WHERE install_id = ? AND status = 'failed'")
            .bind(JSON.stringify(evidence), install_id),
          db.prepare(`INSERT INTO audit_log
            (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
            VALUES ('system', 'system', 'rollback.failed_lock_retained', 'install', ?, NULL, ?, ?)`)
            .bind(install_id, JSON.stringify(evidence), now),
        ]);
      }
      if (original_install_id) {
        const evidence = compensationFailureEvidence({
          original_install_id,
          compensation_install_id: install_id,
          error: message,
          mutation_started: mutationStarted,
        });
        await db.prepare("UPDATE installs SET status = 'failed', error = ?, finished_at = ? WHERE install_id = ?")
          .bind(JSON.stringify(evidence), new Date().toISOString(), original_install_id).run();
        await db.prepare("INSERT OR IGNORE INTO install_receipts (install_id, step, status, output_json, created_at) VALUES (?, 'rollback', 'failed', ?, ?)")
          .bind(original_install_id, JSON.stringify(evidence), new Date().toISOString()).run();
        await db.prepare(`INSERT INTO audit_log
          (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
          VALUES ('system', 'system', 'install.compensation_failed', 'install', ?, NULL, ?, ?)`)
          .bind(original_install_id, JSON.stringify(evidence), new Date().toISOString()).run();
      }
      throw err;
    }
  }
}
