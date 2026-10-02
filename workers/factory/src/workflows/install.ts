import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  apexDnsRecords, attachCustomDomain, createAssetsSession, deployScript,
  getZone, uploadAssetFile, uploadScript,
} from "../cf-api.js";
import { readZipFromR2, renderBrand, unzip, writeRenderToR2 } from "../render.js";
import { setInstallStatus, withReceipt } from "../receipt.js";
import type { Env } from "../env.js";

export interface InstallParams {
  install_id: string;
  brand_id: string;
  revision_id: string;
}

interface BrandRow {
  domain: string;
  current_revision_id: string | null;
}

interface RevisionRow {
  template_version_id: string;
  form_artifact_id: string;
  config_json: string;
}

interface TemplateVersionRow {
  r2_key: string;
  status: string;
}

interface FormArtifactRow {
  r2_key: string;
}

/**
 * FA-1: Install a brand onto Cloudflare.
 *
 * Steps (each wrapped in withReceipt for idempotency):
 *   validate → save_rollback → render → upload_assets → upload_script →
 *   deploy → attach_domains → smoke → receipt
 *
 * On any step failure, the rollback step fires automatically.
 */
export class InstallBrandWorkflow extends WorkflowEntrypoint<Env, InstallParams> {
  async run(event: WorkflowEvent<InstallParams>, step: WorkflowStep): Promise<void> {
    const { install_id, brand_id, revision_id } = event.payload;
    const { FACTORY: db, ARTIFACTS, CF_ACCOUNT_ID, CF_API_TOKEN } = this.env;

    await setInstallStatus(db, install_id, "running");

    try {
      // ── Step 1: Validate ───────────────────────────────────────────────────
      const { zone_id, domain } = await step.do("validate", async () => {
        return withReceipt(db, install_id, "validate", async () => {
          const brand = await db
            .prepare("SELECT domain FROM brands WHERE brand_id = ?")
            .bind(brand_id)
            .first<BrandRow>();
          if (!brand) throw new Error(`Brand ${brand_id} not found`);

          const revision = await db
            .prepare("SELECT template_version_id FROM brand_revisions WHERE revision_id = ?")
            .bind(revision_id)
            .first<{ template_version_id: string }>();
          if (!revision) throw new Error(`Revision ${revision_id} not found`);

          const tv = await db
            .prepare("SELECT status FROM template_versions WHERE template_version_id = ?")
            .bind(revision.template_version_id)
            .first<{ status: string }>();
          if (!tv) throw new Error("Template version not found");
          if (tv.status !== "sealed") throw new Error("Template version is not sealed");

          const zone = await getZone(CF_API_TOKEN, brand.domain);
          const conflicts = await apexDnsRecords(CF_API_TOKEN, zone.id, brand.domain);
          if (conflicts.length > 0) {
            const names = conflicts.map((r) => `${r.type} ${r.name}`).join(", ");
            throw new Error(`Existing DNS records block Custom Domain attach: ${names}`);
          }

          return { zone_id: zone.id, domain: brand.domain };
        });
      });

      // ── Step 2: Save rollback record ───────────────────────────────────────
      await step.do("save_rollback", async () => {
        return withReceipt(db, install_id, "save_rollback", async () => {
          const brand = await db
            .prepare("SELECT current_revision_id FROM brands WHERE brand_id = ?")
            .bind(brand_id)
            .first<{ current_revision_id: string | null }>();
          const rollback = { previous_revision_id: brand?.current_revision_id ?? null };
          await db
            .prepare("UPDATE installs SET rollback_record_json = ? WHERE install_id = ?")
            .bind(JSON.stringify(rollback), install_id)
            .run();
          return rollback;
        });
      });

      // ── Step 3: Render ─────────────────────────────────────────────────────
      const { render_r2_key } = await step.do("render", async () => {
        return withReceipt(db, install_id, "render", async () => {
          const revision = await db
            .prepare("SELECT template_version_id, form_artifact_id FROM brand_revisions WHERE revision_id = ?")
            .bind(revision_id)
            .first<RevisionRow>();
          if (!revision) throw new Error(`Revision ${revision_id} not found`);

          const [tv, fa] = await Promise.all([
            db.prepare("SELECT r2_key FROM template_versions WHERE template_version_id = ?")
              .bind(revision.template_version_id).first<TemplateVersionRow>(),
            db.prepare("SELECT r2_key FROM form_artifacts WHERE form_artifact_id = ?")
              .bind(revision.form_artifact_id).first<FormArtifactRow>(),
          ]);
          if (!tv || !fa) throw new Error("Template version or form artifact R2 key missing");

          const [templateFiles, formFiles] = await Promise.all([
            readZipFromR2(ARTIFACTS, tv.r2_key),
            readZipFromR2(ARTIFACTS, fa.r2_key),
          ]);

          const { files } = await renderBrand(templateFiles, formFiles, brand_id, revision_id);
          const key = await writeRenderToR2(ARTIFACTS, brand_id, revision_id, files);
          return { render_r2_key: key };
        });
      });

      // ── Step 4: Upload assets ──────────────────────────────────────────────
      const { assets_jwt } = await step.do("upload_assets", async () => {
        return withReceipt(db, install_id, "upload_assets", async () => {
          const renderObj = await ARTIFACTS.get(render_r2_key);
          if (!renderObj) throw new Error(`Render artifact not found: ${render_r2_key}`);

          const files = unzip(new Uint8Array(await renderObj.arrayBuffer()));
          const fileList = await Promise.all(
            [...files.entries()].map(async ([path, content]) => {
              const hashBuf = await crypto.subtle.digest("SHA-256", content);
              const hash = Array.from(new Uint8Array(hashBuf))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
              return { path, content, hash, size: content.byteLength };
            }),
          );

          const session = await createAssetsSession(
            CF_API_TOKEN, CF_ACCOUNT_ID,
            fileList.map(({ hash, size }) => ({ hash, size })),
          );

          const needed = new Set(session.buckets.flat());
          await Promise.all(
            fileList
              .filter(({ hash }) => needed.has(hash))
              .map(({ content, hash }) => uploadAssetFile(session.jwt, hash, content, "application/octet-stream")),
          );

          return { assets_jwt: session.jwt };
        });
      });

      // ── Step 5: Upload script ──────────────────────────────────────────────
      const { script_etag } = await step.do("upload_script", async () => {
        return withReceipt(db, install_id, "upload_script", async () => {
          const revision = await db
            .prepare("SELECT config_json FROM brand_revisions WHERE revision_id = ?")
            .bind(revision_id)
            .first<{ config_json: string }>();
          if (!revision) throw new Error(`Revision ${revision_id} not found`);

          const config = JSON.parse(revision.config_json) as Record<string, unknown>;
          const scriptName = `brand-${brand_id}`;

          const scriptObj = await ARTIFACTS.get("runtime/brand-runtime.js");
          if (!scriptObj) throw new Error("Brand runtime bundle not found in ARTIFACTS (key: runtime/brand-runtime.js)");
          const scriptBody = await scriptObj.text();

          const result = await uploadScript(
            CF_API_TOKEN, CF_ACCOUNT_ID, scriptName, scriptBody,
            {
              main_module: "worker.js",
              assets: { jwt: assets_jwt, config: { html_handling: "none" } },
              bindings: [
                { type: "plain_text", name: "BRAND_ID", text: brand_id },
                { type: "plain_text", name: "HOSTNAME", text: domain },
                { type: "json", name: "BRAND_CONFIG", json: config },
                { type: "service", name: "CORE", service: "anjuna-core", entrypoint: "LeadsRpc" },
              ],
              compatibility_date: "2026-08-01",
              compatibility_flags: ["global_fetch_strictly_public"],
            },
          );

          return { script_etag: result.etag };
        });
      });
      void script_etag; // referenced for completeness; version id comes from deploy step

      // ── Step 6: Deploy ─────────────────────────────────────────────────────
      const { worker_version_id } = await step.do("deploy", async () => {
        return withReceipt(db, install_id, "deploy", async () => {
          const scriptName = `brand-${brand_id}`;
          const deployment = await deployScript(CF_API_TOKEN, CF_ACCOUNT_ID, scriptName);
          const versionId = deployment.versions[0]?.version_id;
          if (!versionId) throw new Error("Deploy returned no version id");

          await db
            .prepare("UPDATE brand_revisions SET worker_version_id = ? WHERE revision_id = ?")
            .bind(versionId, revision_id)
            .run();

          return { worker_version_id: versionId };
        });
      });

      // ── Step 7: Attach Custom Domains ──────────────────────────────────────
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

      // ── Step 8: Smoke test ─────────────────────────────────────────────────
      await step.do("smoke", async () => {
        return withReceipt(db, install_id, "smoke", async () => {
          const [apexRes, wwwRes] = await Promise.all([
            fetch(`https://${domain}/`, { redirect: "manual" }),
            fetch(`https://www.${domain}/`, { redirect: "manual" }),
          ]);
          if (apexRes.status !== 200) throw new Error(`Smoke: apex returned ${apexRes.status}`);
          if (![301, 302, 307, 308].includes(wwwRes.status)) throw new Error(`Smoke: www returned ${wwwRes.status} (expected redirect)`);
          return { apex_status: apexRes.status, www_status: wwwRes.status };
        });
      });

      // ── Step 9: Receipt ────────────────────────────────────────────────────
      await step.do("receipt", async () => {
        return withReceipt(db, install_id, "receipt", async () => {
          await db
            .prepare("UPDATE brands SET status = 'live', current_revision_id = ?, updated_at = ? WHERE brand_id = ?")
            .bind(revision_id, new Date().toISOString(), brand_id)
            .run();
          await db
            .prepare("UPDATE installs SET to_revision_id = ? WHERE install_id = ?")
            .bind(revision_id, install_id)
            .run();
          return { installed_at: new Date().toISOString(), worker_version_id };
        });
      });

      await setInstallStatus(db, install_id, "ready");
    } catch (err) {
      await setInstallStatus(db, install_id, "failed", String(err));

      // ── Automatic rollback on failure ──────────────────────────────────────
      await step.do("rollback", async () => {
        return withReceipt(db, install_id, "rollback", async () => {
          const install = await db
            .prepare("SELECT rollback_record_json FROM installs WHERE install_id = ?")
            .bind(install_id)
            .first<{ rollback_record_json: string | null }>();
          const rollback = install?.rollback_record_json
            ? (JSON.parse(install.rollback_record_json) as { previous_revision_id: string | null })
            : null;

          if (!rollback?.previous_revision_id) {
            await db
              .prepare("UPDATE brands SET status = 'failed', updated_at = ? WHERE brand_id = ?")
              .bind(new Date().toISOString(), brand_id)
              .run();
          } else {
            const rollbackInstallId = `rollback-${install_id}`;
            await this.env.ROLLBACK_WORKFLOW.create({
              id: rollbackInstallId,
              params: { install_id: rollbackInstallId, brand_id, to_revision_id: rollback.previous_revision_id },
            });
          }
          return { triggered_rollback: !rollback?.previous_revision_id ? "brand_marked_failed" : "workflow_started" };
        });
      });

      await setInstallStatus(db, install_id, "rolled_back");
    }
  }
}
