/**
 * Template import, certification, and seal pipeline (T11 / FUS-346).
 *
 * Three steps an owner runs before a template version can be used in brand installs:
 *   1. import_template_version  — upload ZIP to R2, create rows in D1
 *   2. certify_template_version — lint + identity scan + screenshots, write certifications
 *   3. seal_template_version    — owner marks as immutable (status = 'sealed')
 */

import { runChecks } from "@anjuna/template-cert";
import type { Source } from "@anjuna/template-cert";
import { unzipSync } from "fflate";
import type { FileMap } from "./archive.js";
import { computeFingerprint } from "./fingerprint.js";
import { similarityCheck, similarityThreshold } from "./tools.js";
import type { Env } from "./env.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unzipToMap(bytes: Uint8Array): FileMap {
  const out = unzipSync(bytes);
  const map: FileMap = new Map();
  for (const [path, data] of Object.entries(out)) {
    if (!path.endsWith("/")) map.set(path, data);
  }
  return map;
}

function toSource(files: FileMap, label: string): Source {
  return { label, files };
}

function iso(): string {
  return new Date().toISOString();
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
const MAX_ZIP_BYTES = 30 * 1024 * 1024;

export async function importTemplateVersion(
  db: D1Database,
  r2: R2Bucket,
  zipBytes: Uint8Array,
  params: {
    template_id: string;
    template_name: string;
    framework: "astro" | "next_export" | "react_spa";
    created_by: string;
  },
): Promise<ImportResult> {
  if (zipBytes.byteLength > MAX_ZIP_BYTES) throw new Error(`ZIP exceeds ${MAX_ZIP_BYTES / (1024 * 1024)} MB limit`);
  const sha256 = await sha256Hex(zipBytes);
  const now = iso();

  // Ensure the parent template row exists.
  await db
    .prepare(
      "INSERT OR IGNORE INTO templates (template_id, name, framework, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(params.template_id, params.template_name, params.framework, params.created_by, now)
    .run();

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
  await db
    .prepare(
      `INSERT INTO template_versions
         (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7)`,
    )
    .bind(template_version_id, params.template_id, version, sha256, r2_key, params.created_by, now)
    .run();

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
}

/**
 * Run all certification checks against the stored ZIP and write certifications rows to D1.
 * Updates template_versions.status to 'certified' or 'rejected'.
 *
 * Browser Rendering screenshots require env.BROWSER (owner-gated, Wave 4).
 * When env.BROWSER is absent the screenshot checks are skipped and a note is included.
 */
export async function certifyTemplateVersion(
  env: Pick<Env, "FACTORY" | "ARTIFACTS" | "BROWSER" | "SIMILARITY_THRESHOLD">,
  template_version_id: string,
  brand_id?: string,
): Promise<CertifyResult> {
  const db = env.FACTORY;
  const r2 = env.ARTIFACTS;
  const now = iso();

  const tv = await db
    .prepare("SELECT r2_key, status FROM template_versions WHERE template_version_id = ?1")
    .bind(template_version_id)
    .first<{ r2_key: string; status: string }>();
  if (!tv) throw new Error(`template_version ${template_version_id} not found`);
  if (tv.status === "sealed") throw new Error("Template version is already sealed");

  // Update status to 'certifying'.
  await db.prepare("UPDATE template_versions SET status = 'certifying' WHERE template_version_id = ?1").bind(template_version_id).run();

  const obj = await r2.get(tv.r2_key);
  if (!obj) throw new Error(`R2 object not found: ${tv.r2_key}`);
  const zipBytes = new Uint8Array(await obj.arrayBuffer());
  const files = unzipToMap(zipBytes);
  const source = toSource(files, template_version_id);

  const checks: CertCheckRow[] = [];
  const repair_messages: string[] = [];

  // ── 1. Lint ─────────────────────────────────────────────────────────────────
  const lintResult = runChecks(source);
  const lintPass = lintResult.ok;
  const lintDetails = {
    errors: lintResult.errors,
    warnings: lintResult.warnings,
    checks: lintResult.checks.map((c) => ({ rule: c.rule, status: c.status, issues: c.issues })),
  };
  checks.push({ check_name: "lint", result: lintPass ? "pass" : "fail", details: lintDetails });
  if (!lintPass) {
    for (const c of lintResult.checks) {
      for (const issue of c.issues) {
        if (issue.severity === "error") repair_messages.push(`[${issue.rule}] ${issue.en}`);
      }
    }
  }

  // ── 2. Identity scan (fingerprint + similarity) ────────────────────────────
  const fingerprint = await computeFingerprint(files);
  const similarity = await similarityCheck(env as Env, files, brand_id);
  const identityPass = similarity.pass;
  const identityDetails = { fingerprint_summary: `${files.size} files`, similarity };
  checks.push({ check_name: "identity_scan", result: identityPass ? "pass" : "fail", details: identityDetails });
  if (!identityPass) {
    repair_messages.push(...similarity.fixes);
  }

  // Store fingerprint for future similarity checks (regardless of pass/fail — for the record).
  await db
    .prepare("INSERT OR REPLACE INTO template_fingerprints (template_version_id, fingerprint_json, created_at) VALUES (?1, ?2, ?3)")
    .bind(template_version_id, JSON.stringify(fingerprint), now)
    .run();

  // ── 3. Screenshots (Browser Rendering — Wave 4 gated) ──────────────────────
  if (env.BROWSER) {
    const htmlEntry = files.get("index.html") ?? files.get("index.htm");
    const html = htmlEntry ? new TextDecoder().decode(htmlEntry) : "<html><body><p>No index.html</p></body></html>";
    for (const viewport of [
      { check_name: "screenshot_desktop" as const, width: 1280, height: 800 },
      { check_name: "screenshot_mobile" as const, width: 390, height: 844 },
    ]) {
      try {
        const screenshotBytes = await takeScreenshot(env.BROWSER, html, viewport.width, viewport.height);
        const key = `screenshots/${template_version_id}/${viewport.check_name}.png`;
        await r2.put(key, screenshotBytes, { httpMetadata: { contentType: "image/png" } });
        checks.push({ check_name: viewport.check_name, result: "pass", details: { width: viewport.width, height: viewport.height }, artifact_r2_key: key });
      } catch (err) {
        checks.push({ check_name: viewport.check_name, result: "fail", details: { error: String(err) } });
      }
    }
  }

  // ── Persist certification rows ─────────────────────────────────────────────
  await db.batch(
    checks.map((c) =>
      db
        .prepare(
          "INSERT INTO certifications (template_version_id, check_name, result, details_json, artifact_r2_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(template_version_id, c.check_name, c.result, JSON.stringify(c.details), c.artifact_r2_key ?? null, now),
    ),
  );

  const allPass = checks.every((c) => c.result === "pass");
  const newStatus = allPass ? "certified" : "rejected";
  await db.prepare("UPDATE template_versions SET status = ?1 WHERE template_version_id = ?2").bind(newStatus, template_version_id).run();

  return { template_version_id, status: newStatus, checks, repair_messages };
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
  ownerSecret: string | undefined,
  envOwnerSecret: string | undefined,
  template_version_id: string,
  sealed_by: string,
): Promise<SealResult> {
  if (!envOwnerSecret) throw new Error("OWNER_SECRET is not configured on this deployment");
  if (ownerSecret !== envOwnerSecret) throw new Error("Invalid owner secret");

  const tv = await db
    .prepare("SELECT status FROM template_versions WHERE template_version_id = ?1")
    .bind(template_version_id)
    .first<{ status: string }>();
  if (!tv) throw new Error(`template_version ${template_version_id} not found`);
  if (tv.status !== "certified") throw new Error(`Cannot seal: status is '${tv.status}', expected 'certified'`);

  const sealed_at = iso();
  await db
    .prepare("UPDATE template_versions SET status = 'sealed', sealed_by = ?2, sealed_at = ?3 WHERE template_version_id = ?1")
    .bind(template_version_id, sealed_by, sealed_at)
    .run();

  return { template_version_id, sealed_by, sealed_at };
}

// ── Browser Rendering helper (Wave 4) ─────────────────────────────────────────

/**
 * Takes a screenshot of `html` at the given viewport using Cloudflare Browser Rendering.
 * Only called when env.BROWSER is bound (production / Wave 4).
 */
async function takeScreenshot(browser: Fetcher, html: string, width: number, height: number): Promise<Uint8Array> {
  // Cloudflare Browser Rendering is accessed via @cloudflare/puppeteer, which uses the BROWSER binding.
  // Dynamic import avoids a hard dep in test environments where puppeteer is absent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const puppeteer: any = await import("@cloudflare/puppeteer" as string).catch(() => null);
  if (!puppeteer) throw new Error("@cloudflare/puppeteer not available");
  const b = await puppeteer.default.launch(browser as unknown as Parameters<typeof puppeteer.default.launch>[0]);
  try {
    const page = await b.newPage();
    await page.setViewport({ width, height });
    await page.setContent(html, { waitUntil: "networkidle0" });
    const buf = await page.screenshot({ type: "png" });
    return new Uint8Array(buf as ArrayBuffer);
  } finally {
    await b.close();
  }
}
