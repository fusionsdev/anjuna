import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";

export interface UpgradeAllParams {
  /** New sealed template version to deploy to every brand using the same template. */
  template_version_id: string;
  /** Form artifact to pair with the new template. */
  form_artifact_id: string;
  /** Brand that receives the update first; if its smoke test passes, the rest follow. */
  canary_brand_id: string;
  /** Auth user triggering the upgrade. */
  started_by: string;
}

interface BrandRow {
  brand_id: string;
  current_revision_id: string | null;
  status: string;
}

interface RevisionRow {
  revision_id: string;
  revision: number;
  config_json: string;
}

function newInstallId(): string {
  return crypto.randomUUID();
}

/**
 * Upgrade every live brand that uses template_version_id to a new revision.
 *
 * Flow:
 *   1. Collect all live brands on the current template version.
 *   2. Run canary install. Fail fast if canary smoke fails.
 *   3. Install the remaining brands (in parallel, bounded).
 */
export class UpgradeAllWorkflow extends WorkflowEntrypoint<Env, UpgradeAllParams> {
  async run(event: WorkflowEvent<UpgradeAllParams>, step: WorkflowStep): Promise<void> {
    const { template_version_id, form_artifact_id, canary_brand_id, started_by } = event.payload;
    const { FACTORY: db } = this.env;
    const now = new Date().toISOString();

    // ── Collect target brands ──────────────────────────────────────────────
    const { brand_ids } = await step.do("collect_brands", async () => {
      const rows = await db
        .prepare(
          `SELECT b.brand_id FROM brands b
           JOIN brand_revisions r ON b.current_revision_id = r.revision_id
           WHERE r.template_version_id = ? AND b.status = 'live'`,
        )
        .bind(template_version_id)
        .all<{ brand_id: string }>();
      const ids = rows.results.map((r) => r.brand_id);
      if (!ids.includes(canary_brand_id)) throw new Error(`Canary brand ${canary_brand_id} is not live on template ${template_version_id}`);
      return { brand_ids: ids };
    });

    // ── Create new revisions for every target brand ────────────────────────
    const { revision_map } = await step.do("create_revisions", async () => {
      const entries: Array<{ brand_id: string; revision_id: string }> = [];
      await Promise.all(
        brand_ids.map(async (brand_id) => {
          const current = await db
            .prepare("SELECT revision FROM brand_revisions WHERE brand_id = ? ORDER BY revision DESC LIMIT 1")
            .bind(brand_id)
            .first<{ revision: number }>();
          const nextRev = (current?.revision ?? 0) + 1;
          const currentRevRow = await db
            .prepare("SELECT config_json FROM brand_revisions WHERE brand_id = ? ORDER BY revision DESC LIMIT 1")
            .bind(brand_id)
            .first<RevisionRow>();

          const revisionId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO brand_revisions (revision_id, brand_id, revision, template_version_id, form_artifact_id, config_json, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(revisionId, brand_id, nextRev, template_version_id, form_artifact_id, currentRevRow?.config_json ?? "{}", started_by, now)
            .run();
          entries.push({ brand_id, revision_id: revisionId });
        }),
      );
      return { revision_map: Object.fromEntries(entries.map(({ brand_id, revision_id }) => [brand_id, revision_id])) };
    });

    // ── Canary install ─────────────────────────────────────────────────────
    await step.do("canary_install", async () => {
      const install_id = newInstallId();
      const revision_id = revision_map[canary_brand_id];
      if (!revision_id) throw new Error(`No revision for canary brand ${canary_brand_id}`);

      await db
        .prepare(
          `INSERT INTO installs (install_id, brand_id, kind, from_revision_id, to_revision_id, is_canary, status, started_by, started_at)
           SELECT ?, ?, 'upgrade', current_revision_id, ?, 1, 'queued', ?, ?
           FROM brands WHERE brand_id = ?`,
        )
        .bind(install_id, canary_brand_id, revision_id, started_by, now, canary_brand_id)
        .run();

      const instance = await this.env.INSTALL_WORKFLOW.create({
        id: install_id,
        params: { install_id, brand_id: canary_brand_id, revision_id },
      });

      // Wait for canary to finish (poll up to 10 minutes).
      for (let i = 0; i < 60; i++) {
        await step.sleep("wait_canary", "10 seconds");
        const status = await instance.status();
        if (status.status === "complete") break;
        if (status.status === "errored") throw new Error(`Canary install failed: ${status.error ?? "unknown"}`);
      }

      const row = await db
        .prepare("SELECT status FROM installs WHERE install_id = ?")
        .bind(install_id)
        .first<{ status: string }>();
      if (row?.status !== "ready") throw new Error(`Canary install did not reach READY (status=${row?.status})`);

      return { canary_install_id: install_id };
    });

    // ── Bulk upgrade remaining brands ──────────────────────────────────────
    const remaining = brand_ids.filter((id) => id !== canary_brand_id);

    await step.do("bulk_installs", async () => {
      await Promise.all(
        remaining.map(async (brand_id) => {
          const revision_id = revision_map[brand_id];
          if (!revision_id) return;
          const install_id = newInstallId();

          await db
            .prepare(
              `INSERT INTO installs (install_id, brand_id, kind, from_revision_id, to_revision_id, is_canary, status, started_by, started_at)
               SELECT ?, ?, 'upgrade', current_revision_id, ?, 0, 'queued', ?, ?
               FROM brands WHERE brand_id = ?`,
            )
            .bind(install_id, brand_id, revision_id, started_by, now, brand_id)
            .run();

          await this.env.INSTALL_WORKFLOW.create({
            id: install_id,
            params: { install_id, brand_id, revision_id },
          });
        }),
      );
      return { started: remaining.length };
    });
  }
}
