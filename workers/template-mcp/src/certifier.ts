/**
 * Template import, certification, and seal pipeline (T11 / FUS-346).
 *
 * Three steps an owner runs before a template version can be used in brand installs:
 *   1. import_template_version  — upload ZIP to R2, create rows in D1
 *   2. certify_template_version — lint + identity scan + screenshots, write certifications
 *   3. seal_template_version    — owner marks as immutable (status = 'sealed')
 */

import { sealTemplateVersionRecord } from "@anjuna/factory-db";
import { runChecks } from "@anjuna/template-cert";
import type { Source } from "@anjuna/template-cert";
import { ruleDisposition } from "@anjuna/template-cert/policy";
import { readStoredWarnings, storedIssues, uniqueIssues } from "./warnings.js";
import type { TemplateSubmitIssue, TemplateTextDefaults, TemplateThemeVars } from "@anjuna/contracts";
import { readZip, type FileMap } from "./archive.js";
import { sha256Hex } from "./auth.js";
import { extractThemeVars } from "./theme-vars.js";
import { computeFingerprint } from "./fingerprint.js";
import { otherBrands, similarityCheck } from "./tools.js";
import type { Env } from "./env.js";
import { takeScreenshot } from "./screenshots.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function toSource(files: FileMap, label: string): Source {
  return { label, files };
}

function iso(): string {
  return new Date().toISOString();
}

function audit(db: D1Database, action: string, id: string, actor: string, role: "owner" | "system", before: unknown, after: unknown, now: string) {
  return db.prepare(`INSERT INTO audit_log
    (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
    SELECT ?1, ?2, ?3, 'template_version', ?4, ?5, ?6, ?7 WHERE changes() > 0`)
    .bind(actor, role, action, id, JSON.stringify(before), JSON.stringify(after), now);
}

const viewports = [
  { check_name: "screenshot_desktop" as const, width: 1280, height: 800 },
  { check_name: "screenshot_mobile" as const, width: 390, height: 844 },
];

async function requireArtifact(r2: R2Bucket, key: string): Promise<void> {
  const artifact = await r2.head(key);
  if (!artifact || artifact.size === 0 || artifact.httpMetadata?.contentType !== "image/png") {
    throw new Error(`Missing PNG screenshot artifact: ${key}. Re-run certification.`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface ImportResult {
  template_version_id: string;
  template_id: string;
  version: number;
  sha256: string;
  r2_key: string;
}

/**
 * Upload a ZIP to R2 and register it as a new template_version row (status = 'draft').
 * Creates the parent template row if template_id is new.
 *
 * @param zipBytes  Raw bytes of the dist/ zip archive.
 * @param params    template_id (caller-chosen), template_name, framework, created_by.
 */
export async function importTemplateVersion(
  db: D1Database,
  r2: R2Bucket,
  zipBytes: Uint8Array,
  params: {
    template_id: string;
    template_name: string;
    framework: "astro" | "next_export" | "react_spa";
    created_by: string;
    /** Builder submit: the builder key (or dashboard user) that sent it. */
    submitted_by?: { key_id: string | null; label: string } | null;
    /** Builder submit: brand name, title and description extracted from index.html. */
    text_defaults?: TemplateTextDefaults | null;
    /** Builder submit: custom properties detected as the primary, primary dark and secondary colors. */
    theme_vars?: TemplateThemeVars | null;
  },
): Promise<ImportResult> {
  // Validate before any D1 or R2 side effects, using the same limits as certification.
  const files = readZip(zipBytes);
  const sha256 = await sha256Hex(zipBytes);
  const now = iso();

  // Spec 2.3: every imported version stores its detected map; a caller that passes
  // an explicit null (or whose zip cannot be read) still gets NULL.
  let theme_vars: TemplateThemeVars | null = params.theme_vars ?? null;
  if (params.theme_vars === undefined) {
    try {
      theme_vars = extractThemeVars(files);
    } catch {
      theme_vars = null;
    }
  }

  // Ensure the parent template row exists.
  const parent = db
    .prepare(
      "INSERT OR IGNORE INTO templates (template_id, name, framework, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(params.template_id, params.template_name, params.framework, params.created_by, now);

  // Next version number for this template.
  const row = await db
    .prepare("SELECT COALESCE(MAX(version), 0) AS max_v FROM template_versions WHERE template_id = ?1")
    .bind(params.template_id)
    .first<{ max_v: number }>();
  const version = (row?.max_v ?? 0) + 1;

  const template_version_id = `tv_${params.template_id}_v${version}`;
  const r2_key = `templates/${params.template_id}/${sha256}.zip`;

  // Upload to R2 (idempotent by key).
  await r2.put(r2_key, zipBytes, { httpMetadata: { contentType: "application/zip" } });

  // Insert the template_version row.
  await db.batch([parent, db
    .prepare(
      `INSERT INTO template_versions
         (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at,
          text_defaults_json, submitted_by_key_id, submitted_by_label, theme_vars_json)
       VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(template_version_id, params.template_id, version, sha256, r2_key, params.created_by, now,
      params.text_defaults ? JSON.stringify(params.text_defaults) : null,
      params.submitted_by?.key_id ?? null, params.submitted_by?.label ?? null,
      theme_vars ? JSON.stringify(theme_vars) : null),
    audit(db, "template.import", template_version_id, params.created_by, "system", null, { status: "draft", sha256, r2_key }, now),
  ]);

  return { template_version_id, template_id: params.template_id, version, sha256, r2_key };
}

// ── Certification ──────────────────────────────────────────────────────────────

export interface CertCheckRow {
  check_name: "lint" | "identity_scan" | "screenshot_desktop" | "screenshot_mobile";
  result: "pass" | "fail";
  details: unknown;
  artifact_r2_key?: string;
}

export interface CertifyResult {
  template_version_id: string;
  status: "certified" | "rejected";
  checks: CertCheckRow[];
  repair_messages: string[];
  warnings: TemplateSubmitIssue[];
}

/**
 * Run all certification checks against the stored ZIP and write certifications rows to D1.
 * Updates template_versions.status to 'certified' or 'rejected'.
 *
 * Browser Rendering screenshots require env.BROWSER (owner-gated, Wave 4).
 * Screenshot failures warn at submit. Seal still requires passing desktop/mobile evidence.
 */
export async function certifyTemplateVersion(
  env: Pick<Env, "FACTORY" | "ARTIFACTS" | "BROWSER" | "SIMILARITY_THRESHOLD">,
  template_version_id: string,
  brand_id?: string,
  importWarnings?: TemplateSubmitIssue[],
): Promise<CertifyResult> {
  const db = env.FACTORY;
  const r2 = env.ARTIFACTS;
  const now = iso();

  const tv = await db
    .prepare("SELECT r2_key, status, template_id FROM template_versions WHERE template_version_id = ?1")
    .bind(template_version_id)
    .first<{ r2_key: string; status: string; template_id: string }>();
  if (!tv) throw new Error(`template_version ${template_version_id} not found`);
  if (tv.status === "sealed") throw new Error("Template version is already sealed");

  const obj = await r2.get(tv.r2_key);
  if (!obj) throw new Error(`R2 object not found: ${tv.r2_key}`);
  const zipBytes = new Uint8Array(await obj.arrayBuffer());
  const files = readZip(zipBytes);
  const source = toSource(files, template_version_id);

  const checks: CertCheckRow[] = [];
  const repair_messages: string[] = [];

  // ── 1. Lint ─────────────────────────────────────────────────────────────────
  const brands = await otherBrands(env, brand_id);
  const lintResult = runChecks(source, { denyDomains: brands.map((b) => b.domain), denyIdentifiers: brands.flatMap((b) => [b.name, ...(b.brand_id ? [b.brand_id] : [])]) });
  const lintPass = lintResult.ok;
  const lintDetails = {
    warning_issues: lintResult.checks.flatMap((c) => c.issues.filter((i) => i.severity === "warning").map((i) => ({
      rule: i.checkId, ...(i.location ? { file: i.location } : {}), message: i.en, fix: i.en,
    }))),
    import_warnings: uniqueIssues([...(await readStoredWarnings(db, template_version_id)).importWarnings, ...(importWarnings ?? [])]),
    errors: lintResult.errors,
    warnings: lintResult.warnings,
    checks: lintResult.checks.map((c) => ({ rule: c.rule, status: c.status, issues: c.issues })),
  };
  checks.push({ check_name: "lint", result: lintPass ? "pass" : "fail", details: lintDetails });
  if (!lintPass) {
    for (const c of lintResult.checks) {
      for (const issue of c.issues) {
        if (issue.severity === "error") repair_messages.push(`[${issue.checkId}] ${issue.en}`);
      }
    }
  }

  // ── 2. Identity scan (fingerprint + similarity) ────────────────────────────
  const fingerprint = await computeFingerprint(files);
  // Earlier sealed versions of the same template are its own history, not another brand's design.
  const similarity = await similarityCheck(env as Env, files, brand_id, tv.template_id);
  const identityPass = similarity.pass;
  const identityIssues: TemplateSubmitIssue[] = similarity.pass ? [] : (similarity.fixes.length ? similarity.fixes : ["Review the layout, copy and images with the owner."])
    .map((fix) => ({ rule: "similarity", message: similarity.summary, fix }));
  const identityDetails = { fingerprint_summary: `${files.size} files`, similarity, warning_issues: identityIssues.filter((i) => ruleDisposition(i.rule) === "warn") };
  checks.push({ check_name: "identity_scan", result: identityPass ? "pass" : "fail", details: identityDetails });
  repair_messages.push(...identityIssues.filter((i) => ruleDisposition(i.rule) === "block").map((i) => `[${i.rule}] ${i.message}`));

  // Record failed screenshots honestly; they block seal, not submission for owner review.
  const runId = crypto.randomUUID();
  for (const viewport of viewports) {
    try {
      if (!env.BROWSER) throw new Error("Bind BROWSER and re-run certification to capture desktop and mobile evidence.");
      const screenshotBytes = await takeScreenshot(env.BROWSER, files, viewport.width, viewport.height);
      if (!screenshotBytes.byteLength) throw new Error("Browser returned an empty screenshot; re-run certification.");
      const key = `screenshots/${template_version_id}/${runId}/${viewport.check_name}.png`;
      await r2.put(key, screenshotBytes, { httpMetadata: { contentType: "image/png" } });
      await requireArtifact(r2, key);
      checks.push({ check_name: viewport.check_name, result: "pass", details: { width: viewport.width, height: viewport.height }, artifact_r2_key: key });
    } catch (err) {
      const issue: TemplateSubmitIssue = { rule: viewport.check_name, message: String(err),
        fix: "This is a platform problem. Tell the owner to re-run certification; passing desktop and mobile screenshots are required before approval." };
      const advisory = ruleDisposition(issue.rule) === "warn";
      checks.push({ check_name: viewport.check_name, result: "fail", details: { error: String(err), warning_issues: advisory ? [issue] : [] } });
      if (!advisory) repair_messages.push(`[${issue.rule}] ${issue.message}`);
    }
  }

  // ── Persist certification rows ─────────────────────────────────────────────
  const allPass = checks.every((c) => c.result === "pass" || ruleDisposition(c.check_name) === "warn") && repair_messages.length === 0;
  const newStatus = allPass ? "certified" : "rejected";
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO template_fingerprints (template_version_id, fingerprint_json, created_at) VALUES (?1, ?2, ?3)")
      .bind(template_version_id, JSON.stringify(fingerprint), now),
    ...checks.map((c) =>
      db
        .prepare(
          "INSERT INTO certifications (template_version_id, check_name, result, details_json, artifact_r2_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(template_version_id, c.check_name, c.result, JSON.stringify(c.details), c.artifact_r2_key ?? null, now),
    ),
    db.prepare("UPDATE template_versions SET status = ?1 WHERE template_version_id = ?2").bind(newStatus, template_version_id),
    audit(db, "template.certify", template_version_id, "system", "system", { status: tv.status }, { status: newStatus, checks }, now),
  ]);

  const warnings = uniqueIssues(checks.flatMap((c) => [...storedIssues(c.details, "warning_issues"), ...storedIssues(c.details, "import_warnings")]));
  return { template_version_id, status: newStatus, checks, repair_messages, warnings };
}

// ── Seal ───────────────────────────────────────────────────────────────────────

export interface SealResult {
  template_version_id: string;
  sealed_by: string;
  sealed_at: string;
}

/**
 * Owner-only: mark a certified template version as sealed (immutable).
 * Rejects if status != 'certified' or owner_secret does not match env.OWNER_SECRET.
 */
export async function sealTemplateVersion(
  db: D1Database,
  r2: R2Bucket,
  ownerSecret: string | undefined,
  envOwnerSecret: string | undefined,
  template_version_id: string,
  sealed_by: string,
): Promise<SealResult> {
  if (!envOwnerSecret) throw new Error("OWNER_SECRET is not configured on this deployment");
  if (ownerSecret !== envOwnerSecret) throw new Error("Invalid owner secret");

  const outcome = await sealTemplateVersionRecord(db, r2, { template_version_id, sealed_by });
  if (!outcome.ok) throw new Error(outcome.message);
  // The MCP tool seals once; a repeat call keeps its old error. Only the dashboard path is idempotent.
  if (outcome.already_sealed) throw new Error("Cannot seal: status is 'sealed', expected 'certified'");
  return { template_version_id, sealed_by: outcome.sealed_by, sealed_at: outcome.sealed_at };
}
