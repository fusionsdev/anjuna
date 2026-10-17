/**
 * Template submit pipeline, shared by submit_template_url (primary for bolt.new), submit_template and
 * finish_upload (Task 6) and the dashboard import (Task 7): deterministic zip, contract checks, similarity,
 * import (R2 + factory D1 draft), certification and text-default extraction. Template code never runs.
 */
import { zipSync } from "fflate";
import {
  TEMPLATE_VERSION_REVIEW_STATUS,
  type TemplateSubmitIssue,
  type TemplateSubmitResult,
  type TemplateTextDefaults,
  type TemplateVersionStatusName,
} from "@anjuna/contracts";
import { InputError, readZip, type FileMap } from "./archive";
import { sha256Hex } from "./auth";
import { certifyTemplateVersion, importTemplateVersion } from "./certifier";
import { checkTemplate, normalizeRoot, type Issue } from "./checker";
import type { Env } from "./env";
import { decode } from "./html";
import { loadFromUrl, type Loaded } from "./input";
import { visibleBodyText } from "./probe";
import { extractTextDefaults } from "./text-defaults";
import { otherBrands, similarityCheck, type SimilarityReport } from "./tools";

const FIXED_MTIME = new Date(2000, 0, 1, 0, 0, 0);

/** Same files give the same bytes and the same SHA-256: sorted paths, fixed timestamps, fixed compression level. */
export function assembleZip(files: FileMap): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const path of [...files.keys()].sort()) entries[path] = files.get(path)!;
  return zipSync(entries, { level: 6, mtime: FIXED_MTIME });
}

/** templates.framework for a build: Astro and Next export leave their folders; everything else is a Vite/React build. */
export function detectFramework(files: FileMap): "astro" | "next_export" | "react_spa" {
  const paths = [...files.keys()];
  if (paths.some((path) => path.startsWith("_astro/"))) return "astro";
  if (paths.some((path) => path.startsWith("_next/"))) return "next_export";
  return "react_spa";
}

// ── Pipeline ───────────────────────────────────────────────────────────────────

export interface SubmittedBy {
  key_id: string | null;
  label: string;
}

export interface SubmitRequest {
  template_id: string;
  template_name: string;
  files: FileMap;
  submitted_by: SubmittedBy;
  /** templates.created_by / template_versions.created_by: the builder key id, or the dashboard user id. */
  created_by: string;
}

export type SubmitResult = TemplateSubmitResult;

const LIMIT_CODES = new Set(["too_large", "file_too_large", "too_many_files"]);
export const REDUCE_IMAGES =
  "Reduce image sizes (compress or resize images, remove unused files) so the build stays under 30 MB, 2000 files and 10 MB per file, then submit again.";
export const NEXT_REJECTED = "Fix every item in issues, rebuild, and submit again the same way.";
const NEXT_WAITING = "Submitted. The owner reviews and approves it in the dashboard under Templates. Nothing else to do.";

export function result(partial: Partial<SubmitResult> & Pick<SubmitResult, "status" | "next_step">): SubmitResult {
  return {
    template_version_id: null, version: null, sha256: null, dashboard_url: null,
    issues: [], warnings: [], text_defaults: null, similarity: null, ...partial,
  };
}

const toIssue = (issue: Issue): TemplateSubmitIssue => ({
  rule: issue.rule,
  ...(issue.file ? { file: issue.file } : {}),
  message: issue.message,
  fix: issue.fix ?? issue.message,
});

/** An over-limit build is the builder's to fix, so it is a rejected result, not a tool error. */
export function limitRejection(error: unknown, warnings: TemplateSubmitIssue[] = []): SubmitResult | null {
  if (!(error instanceof InputError) || !LIMIT_CODES.has(error.code)) return null;
  return result({ status: "rejected", issues: [{ rule: "archive-limits", message: error.message, fix: REDUCE_IMAGES }], warnings, next_step: NEXT_REJECTED });
}

export function dashboardUrl(env: Pick<Env, "DASHBOARD_URL">, templateVersionId: string): string | null {
  return env.DASHBOARD_URL ? `${env.DASHBOARD_URL.replace(/\/+$/, "")}/#templates/${encodeURIComponent(templateVersionId)}` : null;
}

function similarityIssues(report: SimilarityReport): TemplateSubmitIssue[] {
  if (report.pass) return [];
  const fixes = report.fixes.length > 0 ? report.fixes : ["Change the layout, copy and images so the design is clearly different."];
  return fixes.map((fix) => ({ rule: "similarity", message: report.summary, fix }));
}

/** certify repair messages look like "[rule] message". */
function certificationIssue(message: string): TemplateSubmitIssue {
  const match = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(message);
  const rule = match?.[1] ?? "certification";
  const fix = rule.startsWith("screenshot_")
    ? "This is a platform problem, not a template problem. Tell the owner; submit again later without changes."
    : "Fix what the message describes, rebuild, and submit again.";
  return { rule, message: match?.[2] || message, fix };
}

type SimilarityBrief = { pass: boolean; summary: string; fixes: string[] } | null;

/** Certify a stored draft version and turn the outcome into the builder's result. */
async function certifyAndReport(
  env: Env,
  version: { template_version_id: string; version: number; sha256: string },
  extra: { warnings: TemplateSubmitIssue[]; text_defaults: TemplateTextDefaults; similarity: SimilarityBrief },
): Promise<SubmitResult> {
  const certified = await certifyTemplateVersion(env, version.template_version_id);
  const waiting = certified.status === "certified";
  return result({
    status: waiting ? "awaiting_approval" : "rejected",
    template_version_id: version.template_version_id,
    version: version.version,
    sha256: version.sha256,
    dashboard_url: dashboardUrl(env, version.template_version_id),
    issues: waiting ? [] : certified.repair_messages.map(certificationIssue),
    warnings: extra.warnings,
    text_defaults: extra.text_defaults,
    similarity: extra.similarity,
    next_step: waiting ? NEXT_WAITING : NEXT_REJECTED,
  });
}

export async function submitTemplate(env: Env, request: SubmitRequest): Promise<SubmitResult> {
  const { files, notes } = normalizeRoot(request.files);
  const warnings = notes.map(toIssue);

  let zip: Uint8Array;
  try {
    zip = assembleZip(files);
    readZip(zip); // the import limits: 30 MB, 2000 files, 10 MB per file
  } catch (error) {
    const rejected = limitRejection(error, warnings);
    if (rejected) return rejected;
    throw error;
  }
  const sha256 = await sha256Hex(zip);
  const text_defaults = extractTextDefaults(files);

  const existing = await env.FACTORY.prepare("SELECT template_version_id, version, status FROM template_versions WHERE sha256 = ?1")
    .bind(sha256)
    .first<{ template_version_id: string; version: number; status: TemplateVersionStatusName }>();
  if (existing?.status === "rejected") {
    // Same bytes, earlier failed certification (for example a screenshot outage): certify that version again.
    await env.FACTORY.prepare(
      "UPDATE template_versions SET status = 'draft', text_defaults_json = ?2, submitted_by_key_id = ?3, submitted_by_label = ?4 WHERE template_version_id = ?1 AND status = 'rejected'",
    ).bind(existing.template_version_id, JSON.stringify(text_defaults), request.submitted_by.key_id, request.submitted_by.label).run();
    return certifyAndReport(env, { ...existing, sha256 }, { warnings, text_defaults, similarity: null });
  }
  if (existing) {
    return result({
      status: "duplicate", template_version_id: existing.template_version_id, version: existing.version, sha256,
      dashboard_url: dashboardUrl(env, existing.template_version_id), warnings,
      next_step: `This exact build is already version ${existing.version} (${TEMPLATE_VERSION_REVIEW_STATUS[existing.status]}). Nothing was created.`,
    });
  }

  const nameOwner = await env.FACTORY.prepare("SELECT template_id FROM templates WHERE name = ?1 AND template_id != ?2")
    .bind(request.template_name, request.template_id)
    .first<{ template_id: string }>();
  if (nameOwner) {
    return result({
      status: "rejected", sha256, warnings, next_step: NEXT_REJECTED,
      issues: [{
        rule: "template-name",
        message: `The template name "${request.template_name}" already belongs to template_id "${nameOwner.template_id}".`,
        fix: `Send template_id "${nameOwner.template_id}" to add a new version of that template, or choose another template_name.`,
      }],
    });
  }

  const report = checkTemplate(files, { otherBrands: await otherBrands(env) });
  const errors = report.issues.filter((issue) => issue.severity === "error").map(toIssue);
  warnings.push(...report.issues.filter((issue) => issue.severity === "warning").map(toIssue));
  const similarity = await similarityCheck(env, files, undefined, request.template_id);
  const brief = { pass: similarity.pass, summary: similarity.summary, fixes: similarity.fixes };
  if (errors.length > 0 || !similarity.pass) {
    return result({ status: "rejected", sha256, warnings, similarity: brief, issues: [...errors, ...similarityIssues(similarity)], next_step: NEXT_REJECTED });
  }

  const imported = await importTemplateVersion(env.FACTORY, env.ARTIFACTS, zip, {
    template_id: request.template_id,
    template_name: request.template_name,
    framework: detectFramework(files),
    created_by: request.created_by,
    submitted_by: request.submitted_by,
    text_defaults,
  });
  return certifyAndReport(env, imported, { warnings, text_defaults, similarity: brief });
}

// ── Published URL (primary path for bolt.new) ──────────────────────────────────

export const SPA_MESSAGE = "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again.";
const PUBLISH_AGAIN =
  "Publish the site again in bolt.new, open the published URL in a browser to confirm it shows the page, run probe_url on it, then call submit_template_url with that exact URL.";

/** DNS, TLS, connection and timeout failures surface from fetch as TypeError, or DOMException TimeoutError/AbortError. */
const isNetworkFailure = (error: unknown): boolean =>
  error instanceof TypeError || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/** True when index.html has no visible body text: a client-rendered shell whose content only JavaScript would add. */
export function isClientRenderedShell(input: FileMap): boolean {
  const index = normalizeRoot(input).files.get("index.html");
  return index ? visibleBodyText(decode(index)).length === 0 : false; // a missing index.html is the structure check's
}

export interface SubmitUrlRequest extends Omit<SubmitRequest, "files"> {
  url: string;
}

/** Crawl the published site (https, public hosts, 3 redirects, 150 requests; JavaScript never runs), then submit it. */
export async function submitTemplateUrl(env: Env, request: SubmitUrlRequest): Promise<SubmitResult> {
  const { url, ...rest } = request;
  let loaded: Loaded;
  try {
    loaded = await loadFromUrl(url);
  } catch (error) {
    const rejected = limitRejection(error);
    if (rejected) return rejected;
    // Anything wrong with reaching or reading the published URL is the builder's to fix, never an internal error.
    if (error instanceof InputError || isNetworkFailure(error)) {
      const message = error instanceof Error && error.message ? error.message : "The published URL could not be reached.";
      return result({ status: "rejected", next_step: PUBLISH_AGAIN, issues: [{ rule: "published-url", message, fix: PUBLISH_AGAIN }] });
    }
    throw error;
  }
  if (isClientRenderedShell(loaded.files)) {
    return result({
      status: "rejected",
      next_step: SPA_MESSAGE,
      issues: [{
        rule: "static-html",
        file: "index.html",
        message: SPA_MESSAGE,
        fix: "In bolt.new, ask: \"Prerender every page to static HTML at build time so dist/index.html contains the full page text.\" Then publish and submit again.",
      }],
    });
  }
  return submitTemplate(env, { ...rest, files: loaded.files });
}
