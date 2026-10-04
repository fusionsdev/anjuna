import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { attachCustomDomain, deployScript, detachCustomDomain } from "../cf-api.js";
import { setInstallStatus, withReceipt } from "../receipt.js";
import type { Env } from "../env.js";

export interface RollbackParams {
  install_id: string;
  brand_id: string;
  /** null means first-ever install failed before Custom Domains were attached: just mark brand failed. */
  to_revision_id: string | null;
}

interface BrandRow {
  domain: string;
  current_revision_id: string | null;
}

interface RevisionRow {
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
    const { install_id, brand_id, to_revision_id } = event.payload;
    const { FACTORY: db, CF_ACCOUNT_ID, CF_API_TOKEN } = this.env;

    await setInstallStatus(db, install_id, "running");

    try {
      // ── Step 1: Validate ───────────────────────────────────────────────────
      const { zone_id, domain } = await step.do("validate", async () => {
        return withReceipt(db, install_id, "validate", async () => {
          const brand = await db
            .prepare("SELECT domain, current_revision_id FROM brands WHERE brand_id = ?")
            .bind(brand_id)
            .first<BrandRow>();
          if (!brand) throw new Error(`Brand ${brand_id} not found`);

          const { getZone } = await import("../cf-api.js");
          const zone = await getZone(CF_API_TOKEN, brand.domain);
          return { zone_id: zone.id, domain: brand.domain };
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
              (body.result ?? []).map((d) => detachCustomDomain(CF_API_TOKEN, zone_id, d.id)),
            );
            return { detached: body.result?.length ?? 0 };
          });
        });

        await step.do("receipt", async () => {
          return withReceipt(db, install_id, "receipt", async () => {
            await db
              .prepare("UPDATE brands SET status = 'failed', updated_at = ? WHERE brand_id = ?")
              .bind(new Date().toISOString(), brand_id)
              .run();
            return { rolled_back_to: null };
          });
        });
      } else {
        // ── Standard rollback: redeploy previous version ───────────────────
        const { worker_version_id } = await step.do("deploy", async () => {
          return withReceipt(db, install_id, "deploy", async () => {
            const revision = await db
              .prepare("SELECT worker_version_id FROM brand_revisions WHERE revision_id = ?")
              .bind(to_revision_id)
              .first<RevisionRow>();
            if (!revision?.worker_version_id) throw new Error(`Revision ${to_revision_id} has no deployed version id`);

            const scriptName = `brand-${brand_id}`;
            await deployScript(CF_API_TOKEN, CF_ACCOUNT_ID, scriptName, revision.worker_version_id);
            return { worker_version_id: revision.worker_version_id };
          });
        });

        // Ensure Custom Domains still point to this script (they survive version deploys, but re-attach in case).
        await step.do("attach_domains", async () => {
          return withReceipt(db, install_id, "attach_domains", async () => {
            const scriptName = `brand-${brand_id}`;
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

      await setInstallStatus(db, install_id, "rolled_back");
    } catch (err) {
      await setInstallStatus(db, install_id, "failed", String(err));
      throw err;
    }
  }
}
