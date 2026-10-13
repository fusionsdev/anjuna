import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ANALYTICS_FORWARD_PATHS } from "@anjuna/contracts";
import {
  attachCustomDomain, assetContentType, blockingDnsRecords, brandHostnames, createAssetsSession, deployScript, type AssetManifest, uploadAssetBucket,
  getZone, uploadScript,
} from "../cf-api.js";
import { readZipFromR2, renderBrand, unzip, writeRenderToR2 } from "../render.js";
import { assembleBrandConfig, compensationInstallId, deriveAuthoritativeRuntime, rejectQueuedInstall, setInstallStatus, validateInstallInputs, withReceipt } from "../receipt.js";
import { CoreLifecycleClient } from "../core-lifecycle-client.js";
import { SMOKE_RETRY_CONFIG, smokeBrand } from "../smoke.js";
import type { Env } from "../env.js";

export interface InstallParams {
  install_id: string;
  brand_id: string;
  revision_id: string;
}

interface BrandRow {
  brand_id: string;
  name: string;
  account: string;
  domain: string;
  keyword_default: string | null;
  current_revision_id: string | null;
}

interface RevisionRow {
  brand_id: string;
  template_version_id: string;
  form_artifact_id: string;
  config_json: string;
  worker_version_id: string | null;
}

interface TemplateVersionRow {
  r2_key: string;
  status: string;
}

interface FormArtifactRow {
  r2_key: string;
  payload_version: string | null;
  bundle_form_version: string | null;
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
    const terminal = await db.prepare("SELECT status FROM installs WHERE install_id = ?").bind(install_id).first<{ status: string }>();
    if (terminal?.status === "ready" || terminal?.status === "rolled_back") return;
    let mutationStarted = false;

    try {
      await step.do("claim_install", () => setInstallStatus(db, install_id, "running", undefined, brand_id));
      // ── Step 1: Validate ───────────────────────────────────────────────────
      const { zone_id, domain, hostnames: cachedHostnames, name, account, previous_revision_id, initial_runtime } = await step.do("validate", async () => {
        return withReceipt(db, install_id, "validate", async () => {
          const brand = await db
            .prepare("SELECT brand_id, name, account, domain, keyword_default, current_revision_id FROM brands WHERE brand_id = ?")
            .bind(brand_id)
            .first<BrandRow>();
          if (!brand) throw new Error(`Brand ${brand_id} not found`);
          if (brand.account !== this.env.CORE_ACCOUNT) throw new Error("Brand does not belong to configured factory account");
          if (!this.env.CORE_SERVICE_NAME) throw new Error("Core service binding name is missing");

          const revision = await db
            .prepare("SELECT brand_id, template_version_id, form_artifact_id, config_json, worker_version_id FROM brand_revisions WHERE revision_id = ?")
            .bind(revision_id)
            .first<RevisionRow>();
          if (!revision) throw new Error(`Revision ${revision_id} not found`);
          if (revision.brand_id !== brand_id) throw new Error("Revision does not belong to brand");

          const tv = await db
            .prepare("SELECT status FROM template_versions WHERE template_version_id = ?")
            .bind(revision.template_version_id)
            .first<{ status: string }>();
          if (!tv) throw new Error("Template version not found");
          if (tv.status !== "sealed") throw new Error("Template version is not sealed");

          const artifact = await db
            .prepare("SELECT r2_key, payload_version, bundle_form_version FROM form_artifacts WHERE form_artifact_id = ?")
            .bind(revision.form_artifact_id)
            .first<FormArtifactRow>();
          if (!artifact?.r2_key) throw new Error("Form artifact is missing");
          const config = JSON.parse(revision.config_json) as Record<string, unknown>;
          const tenant = {
            account: brand.account,
            aid: this.env.LEADSGATE_AID,
            prepop_base: this.env.LEADSGATE_PREPOP_BASE,
            amount_buckets: JSON.parse(this.env.DEFAULT_AMOUNT_BUCKETS),
            form_route: this.env.DEFAULT_FORM_ROUTE,
            keyword_default: brand.keyword_default ?? "",
            form_version: "",
          };
          const runtimeState = await new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN)
            .runtimeState({ brand_id, account: brand.account });
          validateInstallInputs({
            brand_id,
            revision: { ...revision, template_status: tv.status, config },
            artifact: { present: true, payload_version: artifact.payload_version, bundle_form_version: artifact.bundle_form_version },
            tenant,
            runtime_state: runtimeState,
          });

          const zone = await getZone(CF_API_TOKEN, brand.domain);
          const hostnames = brandHostnames(brand.domain, zone.name);
          const conflicts = await blockingDnsRecords(CF_API_TOKEN, CF_ACCOUNT_ID, zone.id, `brand-${brand_id}`, hostnames);
          if (conflicts.length > 0) {
            const names = conflicts.map((r) => `${r.type} ${r.name}`).join(", ");
            throw new Error(`Existing DNS records block Custom Domain attach: ${names}`);
          }

          return {
            zone_id: zone.id,
            domain: brand.domain,
            hostnames,
            name: brand.name,
            account: brand.account,
            previous_revision_id: brand.current_revision_id,
            initial_runtime: deriveAuthoritativeRuntime(brand_id, tenant, artifact),
          };
        });
      });
      // A Workflow replaying an install started before per-zone hostnames has a cached
      // validate output without them; those installs attached apex plus www, so keep that pair.
      const hostnames = cachedHostnames ?? [domain, `www.${domain}`];

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
      // Re-evaluated on replay even when the following step returns cached output.
      mutationStarted = true;
      const { assets_jwt } = await step.do("upload_assets", async () => {
        return withReceipt(db, install_id, "upload_assets", async () => {
          const renderObj = await ARTIFACTS.get(render_r2_key);
          if (!renderObj) throw new Error(`Render artifact not found: ${render_r2_key}`);

          const files = unzip(new Uint8Array(await renderObj.arrayBuffer()));
          const scriptName = `brand-${brand_id}`;
          const manifest: AssetManifest = {};
          const byHash = new Map<string, { base64: string; contentType: string }>();
          for (const [rawPath, content] of files) {
            const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
            const base64 = bytesToBase64(content);
            const extension = path.includes(".") ? path.split(".").pop()! : "";
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base64 + extension));
            const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
            manifest[path] = { hash, size: content.byteLength };
            byHash.set(hash, { base64, contentType: assetContentType(path) });
          }

          mutationStarted = true;
          const session = await createAssetsSession(CF_API_TOKEN, CF_ACCOUNT_ID, scriptName, manifest);
          let completion = session.buckets.length === 0 ? session.jwt : undefined;
          for (const bucket of session.buckets) {
            const jwt = await uploadAssetBucket(session.jwt, CF_ACCOUNT_ID, bucket.map((hash) => {
              const file = byHash.get(hash);
              if (!file) throw new Error(`Asset session asked for an unknown hash ${hash}`);
              return { hash, ...file };
            }));
            if (jwt) completion = jwt;
          }
          if (!completion) throw new Error("Asset upload did not return a completion token");

          return { assets_jwt: completion };
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

          mutationStarted = true;
          const result = await uploadScript(
            CF_API_TOKEN, CF_ACCOUNT_ID, scriptName, scriptBody,
            {
              main_module: "worker.js",
              assets: { jwt: assets_jwt, config: { html_handling: "none", run_worker_first: true } },
              bindings: [
                { type: "assets", name: "ASSETS" },
                { type: "plain_text", name: "BRAND_ID", text: brand_id },
                { type: "plain_text", name: "HOSTNAME", text: domain },
                { type: "json", name: "BRAND_CONFIG", json: { ...assembleBrandConfig(config, initial_runtime, domain), brand_id, brand: name } },
                { type: "service", name: "CORE", service: this.env.CORE_SERVICE_NAME },
                // Core endpoints for PostHog, Sentry, telemetry and errors (ADR-0004); the runtime defaults to the same table.
                { type: "plain_text", name: "CORE_ANALYTICS_PATHS", text: JSON.stringify(ANALYTICS_FORWARD_PATHS) },
              ],
              compatibility_date: "2026-08-01",
              compatibility_flags: ["global_fetch_strictly_public"],
              core_token: this.env.CORE_TOKEN,
            },
          );
          return { script_etag: result.etag };
        });
      });
      void script_etag; // referenced for completeness; version id comes from deploy step

      if (!previous_revision_id) {
        await step.do("provision_runtime", async () => withReceipt(db, install_id, "provision_runtime", async () => {
          const client = new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN);
          mutationStarted = true;
          const result = await client.applyRuntime({
            install_id, brand_id, account, hostnames,
            expected_revision_id: null, target_revision_id: revision_id,
            actor_id: "system", actor_role: "owner", initial_runtime,
          });
          mutationStarted = true;
          await client.verifyRuntime(brand_id, account, revision_id, install_id);
          return result;
        }));
      }

      // ── Step 6: Deploy ─────────────────────────────────────────────────────
      const { worker_version_id } = await step.do("deploy", async () => {
        return withReceipt(db, install_id, "deploy", async () => {
          const scriptName = `brand-${brand_id}`;
          mutationStarted = true;
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

      // ── Step 8: Smoke test ─────────────────────────────────────────────────
      // Persist only the final outcome. A failed receipt inside the callback would
      // short-circuit every Workflow retry instead of re-fetching the hostnames.
      // An upgrade can target a brand the operator paused: it serves the 503 pause page and
      // stays paused, so smoke expects that page. Core is read on every attempt, inside the
      // step, so a pause toggled during the retry window is seen and the cached step result
      // stays the single replayed outcome. A failed read throws and retries; it never
      // downgrades to a guess. An absent runtime has no pause flag and is smoked as live.
      await withReceipt(db, install_id, "smoke", () =>
        step.do("smoke", SMOKE_RETRY_CONFIG, async () => {
          const state = previous_revision_id
            ? await new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN).runtimeState({ brand_id, account })
            : null;
          return smokeBrand(hostnames, { paused: state?.state === "applied" && state.paused });
        }),
      );

      if (previous_revision_id) {
        await step.do("sync_runtime", async () => withReceipt(db, install_id, "sync_runtime", async () => {
          const client = new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN);
          mutationStarted = true;
          const result = await client.applyRuntime({
            install_id, brand_id, account, hostnames,
            expected_revision_id: previous_revision_id, target_revision_id: revision_id,
            actor_id: "system", actor_role: "owner", initial_runtime,
          });
          await client.verifyRuntime(brand_id, account, revision_id, install_id);
          return result;
        }));
      }

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

      await step.do("finish_install", () => setInstallStatus(db, install_id, "ready", undefined, brand_id));
    } catch (err) {
      const errorMessage = String(err);
      if (errorMessage.includes("lifecycle mutation in progress")) {
        await rejectQueuedInstall(db, install_id, brand_id, errorMessage);
        throw err;
      }
      await setInstallStatus(db, install_id, "failed", errorMessage, brand_id, { retainBrandLock: mutationStarted });

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

          if (!mutationStarted) return { compensation: "not_required" };

          const compensationId = compensationInstallId(install_id);
          await db.prepare(
            "INSERT OR IGNORE INTO installs (install_id, brand_id, kind, status, started_by, started_at, from_revision_id, to_revision_id) VALUES (?, ?, 'rollback', 'queued', 'system', ?, ?, ?)",
          ).bind(compensationId, brand_id, new Date().toISOString(), rollback?.previous_revision_id ?? null, rollback?.previous_revision_id ?? null).run();
          try {
            await this.env.ROLLBACK_WORKFLOW.create({
              id: compensationId,
              params: { install_id: compensationId, original_install_id: install_id, brand_id, to_revision_id: rollback?.previous_revision_id ?? null },
            });
          } catch (compensationError) {
            const evidence = {
              original_install_id: install_id,
              compensation_install_id: compensationId,
              error: String(compensationError),
              recovery_required: true,
              actionable: "An Owner can use Recover in the brand panel to retry compensation and release the retained lock.",
            };
            await db.prepare("UPDATE installs SET status = 'failed', error = ?, finished_at = ? WHERE install_id IN (?, ?)")
              .bind(JSON.stringify(evidence), new Date().toISOString(), install_id, compensationId).run();
            await db.prepare(`INSERT INTO audit_log
              (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
              VALUES ('system', 'system', 'install.compensation_failed', 'install', ?, NULL, ?, ?)`)
              .bind(install_id, JSON.stringify(evidence), new Date().toISOString()).run();
            throw compensationError;
          }
          return { compensation_install_id: compensationId, triggered_rollback: "workflow_started" };
        });
      });
    }
  }
}

/** Base64 for asset uploads, chunked so large files do not overflow the argument limit. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
