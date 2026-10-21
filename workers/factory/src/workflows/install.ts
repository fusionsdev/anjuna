import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { ANALYTICS_FORWARD_PATHS, BrandProfile, type ApplyRuntimeResponse, type InstallMailingListResponse } from "@anjuna/contracts";
import {
  attachCustomDomain, assetContentType, blockingDnsRecords, brandHostnames, createAssetsSession, deployScript, type AssetManifest, uploadAssetBucket,
  getZone, uploadScript,
} from "../cf-api.js";
import { readZipFromR2, renderBrand, unzip, writeRenderToR2 } from "../render.js";
import { assembleBrandConfig, compensationInstallId, deriveAuthoritativeRuntime, rejectQueuedInstall, setInstallStatus, validateInstallInputs, stepErrorText } from "../receipt.js";
import { CoreLifecycleClient, CoreLifecycleError } from "../core-lifecycle-client.js";
import {
  LOCAL_STEP_RETRY_CONFIG, REMOTE_STEP_RETRY_CONFIG, VALIDATE_RETRY_CONFIG, failFast, instanceState, receiptInRetriedStep, stepReceipt,
} from "../step-receipt.js";
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

/** A computation on rows and bytes already read: the same input fails the same way, so any failure settles the step at once. */
async function settleOnFailure<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw err instanceof NonRetryableError ? err : new NonRetryableError(err instanceof Error ? err.message : String(err));
  }
}

interface FormArtifactRow {
  r2_key: string;
  payload_version: string | null;
  bundle_form_version: string | null;
}

/**
 * FA-1: Install a brand onto Cloudflare.
 *
 * Steps (each records a receipt for idempotency, with the retry rule of receiptInRetriedStep):
 *   validate → save_rollback → render → upload_assets → upload_script → [provision_runtime, first install] →
 *   deploy → attach_domains → smoke → sync_runtime → receipt
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
      // Receipt reads and writes sit inside the retried step, so a transient D1 error retries the step instead
      // of failing the install. A failed receipt is stored only on the final attempt: see receiptInRetriedStep.
      const { zone_id, domain, hostnames: cachedHostnames, name, account, previous_revision_id, initial_runtime } = await step.do("validate", VALIDATE_RETRY_CONFIG, async (ctx) => {
        return receiptInRetriedStep(db, install_id, "validate", VALIDATE_RETRY_CONFIG.retries.limit, ctx.attempt, () => failFast(async () => {
          const brand = await db
            .prepare("SELECT brand_id, name, account, domain, keyword_default, current_revision_id FROM brands WHERE brand_id = ?")
            .bind(brand_id)
            .first<BrandRow>();
          if (!brand) throw new NonRetryableError(`Brand ${brand_id} not found`);
          if (brand.account !== this.env.CORE_ACCOUNT) throw new NonRetryableError("Brand does not belong to configured factory account");
          if (!this.env.CORE_SERVICE_NAME) throw new NonRetryableError("Core service binding name is missing");

          const revision = await db
            .prepare("SELECT brand_id, template_version_id, form_artifact_id, config_json, worker_version_id FROM brand_revisions WHERE revision_id = ?")
            .bind(revision_id)
            .first<RevisionRow>();
          if (!revision) throw new NonRetryableError(`Revision ${revision_id} not found`);
          if (revision.brand_id !== brand_id) throw new NonRetryableError("Revision does not belong to brand");

          const tv = await db
            .prepare("SELECT status FROM template_versions WHERE template_version_id = ?")
            .bind(revision.template_version_id)
            .first<{ status: string }>();
          if (!tv) throw new NonRetryableError("Template version not found");
          if (tv.status !== "sealed") throw new NonRetryableError("Template version is not sealed");

          const artifact = await db
            .prepare("SELECT r2_key, payload_version, bundle_form_version FROM form_artifacts WHERE form_artifact_id = ?")
            .bind(revision.form_artifact_id)
            .first<FormArtifactRow>();
          if (!artifact?.r2_key) throw new NonRetryableError("Form artifact is missing");
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
          try {
            validateInstallInputs({
              brand_id,
              revision: { ...revision, template_status: tv.status, config },
              artifact: { present: true, payload_version: artifact.payload_version, bundle_form_version: artifact.bundle_form_version },
              tenant,
              runtime_state: runtimeState,
            });
          } catch (invalid) {
            // Every check is a pure function of rows and Core state already read.
            throw new NonRetryableError((invalid as Error).message);
          }

          const zone = await getZone(CF_API_TOKEN, brand.domain);
          const hostnames = brandHostnames(brand.domain, zone.name);
          const conflicts = await blockingDnsRecords(CF_API_TOKEN, CF_ACCOUNT_ID, zone.id, `brand-${brand_id}`, hostnames);
          if (conflicts.length > 0) {
            const names = conflicts.map((r) => `${r.type} ${r.name}`).join(", ");
            throw new NonRetryableError(`Existing DNS records block Custom Domain attach: ${names}`);
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
        }));
      });
      // A Workflow replaying an install started before per-zone hostnames has a cached
      // validate output without them; those installs attached apex plus www, so keep that pair.
      const hostnames = cachedHostnames ?? [domain, `www.${domain}`];

      // ── Step 2: Save rollback record ───────────────────────────────────────
      // Steps 2 to 9 and sync_runtime share validate's receipt rule (receiptInRetriedStep, see stepReceipt): the failed
      // receipt waits for the last attempt, and a deterministic failure settles at once. Re-running one after its work
      // succeeded but its ok receipt write failed is safe, with the cost noted on each step.
      // Re-run: reads the brand's current revision and writes the same rollback record again.
      await step.do("save_rollback", LOCAL_STEP_RETRY_CONFIG, async (ctx) => {
        return stepReceipt(db, install_id, "save_rollback", LOCAL_STEP_RETRY_CONFIG, ctx, async () => {
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
      // Re-run: renders the same bytes (the salt is derived from the brand and revision) over the same R2 key.
      const { render_r2_key } = await step.do("render", LOCAL_STEP_RETRY_CONFIG, async (ctx) => {
        return stepReceipt(db, install_id, "render", LOCAL_STEP_RETRY_CONFIG, ctx, async () => {
          const revision = await db
            .prepare("SELECT template_version_id, form_artifact_id FROM brand_revisions WHERE revision_id = ?")
            .bind(revision_id)
            .first<RevisionRow>();
          if (!revision) throw new NonRetryableError(`Revision ${revision_id} not found`);

          const [tv, fa] = await Promise.all([
            db.prepare("SELECT r2_key FROM template_versions WHERE template_version_id = ?")
              .bind(revision.template_version_id).first<TemplateVersionRow>(),
            db.prepare("SELECT r2_key FROM form_artifacts WHERE form_artifact_id = ?")
              .bind(revision.form_artifact_id).first<FormArtifactRow>(),
          ]);
          if (!tv || !fa) throw new NonRetryableError("Template version or form artifact R2 key missing");

          const [templateFiles, formFiles] = await Promise.all([
            readZipFromR2(ARTIFACTS, tv.r2_key),
            readZipFromR2(ARTIFACTS, fa.r2_key),
          ]);

          const { files } = await settleOnFailure(() => renderBrand(templateFiles, formFiles, brand_id, revision_id));
          const key = await writeRenderToR2(ARTIFACTS, brand_id, revision_id, files);
          return { render_r2_key: key };
        });
      });

      // ── Step 4: Upload assets ──────────────────────────────────────────────
      // Re-evaluated on replay even when the following step returns cached output.
      mutationStarted = true;
      // Re-run: Cloudflare keeps assets by content hash, so a new session asks only for the files it still lacks.
      const { assets_jwt } = await step.do("upload_assets", REMOTE_STEP_RETRY_CONFIG, async (ctx) => {
        return stepReceipt(db, install_id, "upload_assets", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
          const renderObj = await ARTIFACTS.get(render_r2_key);
          if (!renderObj) throw new NonRetryableError(`Render artifact not found: ${render_r2_key}`);

          const renderBytes = new Uint8Array(await renderObj.arrayBuffer());
          const files = await settleOnFailure(() => unzip(renderBytes));
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
              if (!file) throw new NonRetryableError(`Asset session asked for an unknown hash ${hash}`);
              return { hash, ...file };
            }));
            if (jwt) completion = jwt;
          }
          if (!completion) throw new Error("Asset upload did not return a completion token");

          return { assets_jwt: completion };
        });
      });

      // ── Step 5: Upload script ──────────────────────────────────────────────
      // Re-run: a second PUT of the same script creates one more Worker version with the same content and deploys it.
      const { script_etag } = await step.do("upload_script", REMOTE_STEP_RETRY_CONFIG, async (ctx) => {
        return stepReceipt(db, install_id, "upload_script", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
          const revision = await db
            .prepare("SELECT config_json FROM brand_revisions WHERE revision_id = ?")
            .bind(revision_id)
            .first<{ config_json: string }>();
          if (!revision) throw new NonRetryableError(`Revision ${revision_id} not found`);

          const config = JSON.parse(revision.config_json) as Record<string, unknown>;
          const scriptName = `brand-${brand_id}`;

          const scriptObj = await ARTIFACTS.get("runtime/brand-runtime.js");
          if (!scriptObj) throw new NonRetryableError("Brand runtime bundle not found in ARTIFACTS (key: runtime/brand-runtime.js)");
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
        // Re-run: Core answers a repeated install_id with a noop and changes nothing (workers/core/src/lifecycle.ts, applyRuntime).
        await step.do("provision_runtime", REMOTE_STEP_RETRY_CONFIG, async (ctx) => stepReceipt(db, install_id, "provision_runtime", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
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
      // Re-run: reads the script's latest deployment and sets the revision's version id again.
      const { worker_version_id } = await step.do("deploy", REMOTE_STEP_RETRY_CONFIG, async (ctx) => {
        return stepReceipt(db, install_id, "deploy", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
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
      // Re-run: the Workers Domains PUT attaches a hostname to the same script again. A rollback and an upgrade of a
      // live brand already repeat it on hostnames that are attached, and their receipts end ok.
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

      // ── Step 8: Smoke test ─────────────────────────────────────────────────
      // The receipt read and write run inside the retried step, so a transient D1 error retries the step
      // instead of failing the install. A failed receipt is stored only on the final attempt: a failed
      // receipt inside the callback would short-circuit every Workflow retry instead of re-fetching the hostnames.
      // An upgrade can target a brand the operator paused: it serves the 503 pause page and
      // stays paused, so smoke expects that page. Core is read on every attempt, inside the
      // step, so a pause toggled during the retry window is seen and the cached step result
      // stays the single replayed outcome. A failed read throws and retries; it never
      // downgrades to a guess. An absent runtime has no pause flag and is smoked as live.
      await step.do("smoke", SMOKE_RETRY_CONFIG, async (ctx) => {
        return receiptInRetriedStep(db, install_id, "smoke", SMOKE_RETRY_CONFIG.retries.limit, ctx.attempt, async () => {
          const state = previous_revision_id
            ? await new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN).runtimeState({ brand_id, account })
            : null;
          const paused = state?.state === "applied" && state.paused;
          const result = await smokeBrand(hostnames, { paused });
          // The checklist's final_url row is computed from this: the live brand URL answered with its landing page.
          return paused ? result : { ...result, final_url: `https://${hostnames[0]}/` };
        });
      });

      // ── Step 9: Sync runtime ───────────────────────────────────────────────
      // Runs on every install. A live brand's install applies the new revision to Core here (a first install did that in
      // provision_runtime). A first install copies the draft's ads routing into Core, and every install makes sure the brand
      // has its own listmonk list. Re-run: Core answers a repeated install_id with a noop (workers/core/src/lifecycle.ts,
      // applyRuntime), writes ads routing only into NULL columns, and answers a stored list id without calling listmonk.
      await step.do("sync_runtime", REMOTE_STEP_RETRY_CONFIG, async (ctx) => stepReceipt(db, install_id, "sync_runtime", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
        const client = new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN);
        let result: ApplyRuntimeResponse | undefined;
        if (previous_revision_id) {
          mutationStarted = true;
          result = await client.applyRuntime({
            install_id, brand_id, account, hostnames,
            expected_revision_id: previous_revision_id, target_revision_id: revision_id,
            actor_id: "system", actor_role: "owner", initial_runtime,
          });
          await client.verifyRuntime(brand_id, account, revision_id, install_id);
        }
        // First install only: after go-live the owner manages the route in the control panel, and a column the owner
        // cleared on purpose must stay clear through a later redeploy or upgrade.
        const ads = previous_revision_id ? null : await draftAds(db, revision_id);
        const ads_routing = ads ? await client.adsRouting({ install_id, brand_id, account, ads }) : undefined;
        let mailing_list: InstallMailingListResponse;
        try {
          // listmonk may answer slower than Core's own 3 s budget: two calls (find, then create).
          mailing_list = await new CoreLifecycleClient(this.env.CORE_LIFECYCLE, this.env.CORE_TOKEN, 15_000)
            .mailingList({ install_id, brand_id, account });
        } catch (err) {
          if (err instanceof CoreLifecycleError) throw new CoreLifecycleError(`Mailing list: ${err.message}`, err.deterministic);
          throw err;
        }
        return { ...result, ...(ads_routing ? { ads_routing } : {}), mailing_list };
      }));

      // ── Step 10: Receipt ────────────────────────────────────────────────────
      // Re-run: sets the same brand and install columns again; only installed_at moves.
      await step.do("receipt", LOCAL_STEP_RETRY_CONFIG, async (ctx) => {
        return stepReceipt(db, install_id, "receipt", LOCAL_STEP_RETRY_CONFIG, ctx, async () => {
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
      // The engine prefixes a NonRetryableError message with its name: the panel keeps reading "Error: <message>".
      const errorMessage = stepErrorText(err);
      if (errorMessage.includes("lifecycle mutation in progress")) {
        await rejectQueuedInstall(db, install_id, brand_id, errorMessage);
        throw err;
      }
      await setInstallStatus(db, install_id, "failed", errorMessage, brand_id, { retainBrandLock: mutationStarted });

      // ── Automatic rollback on failure ──────────────────────────────────────
      // The compensation install row is INSERT OR IGNORE and its Workflow instance id is the compensation install id, so a repeated
      // dispatch is the one re-run here that cannot simply run again: a retry after a dispatch that worked, but whose ok receipt write
      // failed, finds the instance and stops there. The recovery evidence is written only when no retry is left.
      await step.do("rollback", REMOTE_STEP_RETRY_CONFIG, async (ctx) => {
        return stepReceipt(db, install_id, "rollback", REMOTE_STEP_RETRY_CONFIG, ctx, async () => {
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
            if (await instanceState(this.env.ROLLBACK_WORKFLOW, compensationId) === "present") return { compensation_install_id: compensationId, triggered_rollback: "workflow_started" };
            if (ctx.attempt <= REMOTE_STEP_RETRY_CONFIG.retries.limit) throw compensationError;
            // Last attempt, and the instance is absent or its lookup failed. The rows are marked failed with recovery evidence, which keeps the
            // brand lock and gives the Owner a Recover path. An instance that exists anyway cannot mutate the brand while the rows say failed: its
            // claim refuses a finished compensation row, and one that had already claimed ends in finish_rollback, which overwrites these rows.
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

/**
 * The draft's Google Ads routing (`profile.ads` in the revision config), without microsoft_ads_account: brand_runtime
 * has no column for it, so it stays in the revision config. Null when the draft sets none of the three fields.
 */
async function draftAds(db: D1Database, revisionId: string) {
  const revision = await db.prepare("SELECT config_json FROM brand_revisions WHERE revision_id = ?").bind(revisionId).first<{ config_json: string }>();
  if (!revision) throw new NonRetryableError(`Revision ${revisionId} not found`);
  const raw = (JSON.parse(revision.config_json) as { profile?: { ads?: unknown } }).profile?.ads;
  if (raw === undefined) return null;
  const parsed = BrandProfile.shape.ads.safeParse(raw);
  if (!parsed.success || !parsed.data) throw new NonRetryableError("Draft ads routing (profile.ads) is invalid");
  const { google_ads_account, google_conversion_action, adkit_project } = parsed.data;
  const ads = {
    ...(google_ads_account ? { google_ads_account } : {}),
    ...(google_conversion_action ? { google_conversion_action } : {}),
    ...(adkit_project ? { adkit_project } : {}),
  };
  return Object.keys(ads).length > 0 ? ads : null;
}

/** Base64 for asset uploads, chunked so large files do not overflow the argument limit. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
