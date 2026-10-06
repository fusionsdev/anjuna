import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { attachCustomDomain, deployScript, detachCustomDomain } from "../cf-api.js";
import { compensationFailureEvidence, setInstallStatus, shouldRetainBrandLockOnFailure, withReceipt } from "../receipt.js";
import { rollbackTargetBelongsToBrand } from "../receipt.js";
import { CoreLifecycleClient } from "../core-lifecycle-client.js";
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
    let mutationStarted = false;

    await setInstallStatus(db, install_id, "running", undefined, brand_id, original_install_id
      ? { compensationForInstallId: original_install_id }
      : {});

    try {
      // ── Step 1: Validate ───────────────────────────────────────────────────
      const { zone_id, domain, account, current_revision_id } = await step.do("validate", async () => {
        return withReceipt(db, install_id, "validate", async () => {
          const brand = await db
            .prepare("SELECT domain, account, current_revision_id FROM brands WHERE brand_id = ?")
            .bind(brand_id)
            .first<BrandRow>();
          if (!brand) throw new Error(`Brand ${brand_id} not found`);

          const { getZone } = await import("../cf-api.js");
          const zone = await getZone(CF_API_TOKEN, brand.domain);
          return { zone_id: zone.id, domain: brand.domain, account: brand.account, current_revision_id: brand.current_revision_id };
        });
      });

      if (!to_revision_id) {
        // ── First-install rollback: detach domains ─────────────────────────
        await step.do("attach_domains", async () => {
          return withReceipt(db, install_id, "attach_domains", async () => {
            // Find any domain records we may have attached and remove them.
            const existing = await fetch(
              `https://api.cloudflare.com/client/v4/zones/${zone_id}/workers/domains?service=brand-${brand_id}`,
              { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } },
            );
            const body = await existing.json<{ result: Array<{ id: string }> }>();
            await Promise.all(
              (body.result ?? []).map((d) => {
                mutationStarted = true;
                return detachCustomDomain(CF_API_TOKEN, zone_id, d.id);
              }),
            );
            return { detached: body.result?.length ?? 0 };
          });
        });

        await step.do("sync_runtime", async () => withReceipt(db, install_id, "sync_runtime", async () => {
          const client = new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN);
          const current = await client.runtimeState({ brand_id, account });
          if (current.state === "absent") return { state: "absent", paused: false };
          mutationStarted = true;
          const result = await client.applyRuntime({
            install_id, brand_id, account, hostnames: [domain, `www.${domain}`],
            expected_revision_id: current_revision_id, target_revision_id: null,
            actor_id: "system", actor_role: "owner",
          });
          const state = await client.runtimeState({ brand_id, account });
          if (state.state !== "applied" || !state.paused) throw new Error("Core runtime did not pause during detach");
          return result;
        }));

        await step.do("receipt", async () => {
          return withReceipt(db, install_id, "receipt", async () => {
            await db
              .prepare("UPDATE brands SET status = 'draft', current_revision_id = NULL, updated_at = ? WHERE brand_id = ?")
              .bind(new Date().toISOString(), brand_id)
              .run();
            return { rolled_back_to: null, detached: true };
          });
        });
      } else {
        // ── Standard rollback: redeploy previous version ───────────────────
        const { worker_version_id } = await step.do("deploy", async () => {
          return withReceipt(db, install_id, "deploy", async () => {
            const revision = await db
              .prepare("SELECT brand_id, worker_version_id FROM brand_revisions WHERE revision_id = ?")
              .bind(to_revision_id)
              .first<RevisionRow>();
            if (!revision || !rollbackTargetBelongsToBrand(revision, brand_id)) throw new Error(`Revision ${to_revision_id} is not a deployed revision for this brand`);

            const scriptName = `brand-${brand_id}`;
            mutationStarted = true;
            await deployScript(CF_API_TOKEN, CF_ACCOUNT_ID, scriptName, revision.worker_version_id!);
            return { worker_version_id: revision.worker_version_id! };
          });
        });

        await step.do("sync_runtime", async () => withReceipt(db, install_id, "sync_runtime", async () => {
          const client = new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN);
          mutationStarted = true;
          const result = await client.applyRuntime({
            install_id, brand_id, account, hostnames: [domain, `www.${domain}`],
            expected_revision_id: current_revision_id, target_revision_id: to_revision_id,
            actor_id: "system", actor_role: "owner",
          });
          await client.verifyRuntime(brand_id, account, to_revision_id, install_id);
          return result;
        }));

        // Ensure Custom Domains still point to this script (they survive version deploys, but re-attach in case).
        await step.do("attach_domains", async () => {
          return withReceipt(db, install_id, "attach_domains", async () => {
            const scriptName = `brand-${brand_id}`;
            mutationStarted = true;
            const [apex, www] = await Promise.all([
              attachCustomDomain(CF_API_TOKEN, zone_id, domain, scriptName),
              attachCustomDomain(CF_API_TOKEN, zone_id, `www.${domain}`, scriptName),
            ]);
            return { apex_domain_id: apex.id, www_domain_id: www.id };
          });
        });

        await step.do("receipt", async () => {
          return withReceipt(db, install_id, "receipt", async () => {
            await db
              .prepare("UPDATE brands SET status = 'live', current_revision_id = ?, updated_at = ? WHERE brand_id = ?")
              .bind(to_revision_id, new Date().toISOString(), brand_id)
              .run();
            return { rolled_back_to: to_revision_id, worker_version_id };
          });
        });
      }

      await setInstallStatus(db, install_id, "rolled_back", undefined, brand_id, { preserveBrandStatus: !to_revision_id });
      if (original_install_id) {
        const evidence = {
          original_install_id,
          compensation_install_id: install_id,
          restored_to_revision_id: to_revision_id,
          final_verification: "passed",
        };
        await db.prepare("UPDATE installs SET status = 'rolled_back', error = NULL, finished_at = ? WHERE install_id = ?")
          .bind(new Date().toISOString(), original_install_id).run();
        await db.prepare("INSERT OR IGNORE INTO install_receipts (install_id, step, status, output_json, created_at) VALUES (?, 'rollback', 'ok', ?, ?)")
          .bind(original_install_id, JSON.stringify(evidence), new Date().toISOString()).run();
        await db.prepare(`INSERT INTO audit_log
          (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
          VALUES ('system', 'system', 'install.compensation_succeeded', 'install', ?, NULL, ?, ?)`)
          .bind(original_install_id, JSON.stringify(evidence), new Date().toISOString()).run();
      }
    } catch (err) {
      const message = String(err);
      await setInstallStatus(db, install_id, "failed", message, brand_id, {
        retainBrandLock: shouldRetainBrandLockOnFailure(mutationStarted, original_install_id),
      });
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
