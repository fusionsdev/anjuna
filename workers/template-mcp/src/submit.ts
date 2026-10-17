/**
 * Template submit pipeline, shared by submit_template_url (primary for bolt.new), submit_template and
 * finish_upload (Task 6) and the dashboard import (Task 7): deterministic zip, contract checks, similarity,
 * import (R2 + factory D1 draft), certification and text-default extraction. Template code never runs.
 */
import { zipSync } from "fflate";
import { z } from "zod";
import {
  TEMPLATE_VERSION_REVIEW_STATUS,
  type TemplateSubmitIssue,
  type TemplateSubmitResult,
  type TemplateTextDefaults,
  type TemplateVersionStatusName,
} from "@anjuna/contracts";
import { InputError, LIMITS, readZip, safePath, type FileMap } from "./archive";
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

// ── File list (submit_template) and chunked upload (fallback path) ─────────────

export const SUBMITTED_FILE = z.object({
  path: z.string().min(1).max(512).describe("Path inside dist/, e.g. index.html, privacy/index.html, assets/site.css."),
  content: z.string().describe("The file content: plain text when encoding is utf8, base64 when encoding is base64."),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("utf8 for HTML, CSS, JS, SVG and JSON; base64 for images and fonts."),
});
export type SubmittedFile = z.input<typeof SUBMITTED_FILE>;

export const SUBMIT_SHAPE = {
  template_id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Use 2-63 lowercase letters, digits or dashes, e.g. harbor-funding")
    .describe("Lowercase slug for this template. Send the same template_id again to add a new version."),
  template_name: z.string().trim().min(1).max(128).describe("Template name shown in the dashboard."),
  files: z.array(SUBMITTED_FILE).min(1).max(LIMITS.maxFiles).describe("Every file inside dist/ after npm run build."),
};

function fromBase64(path: string, value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value.replace(/\s+/g, ""));
  } catch {
    throw new InputError("bad_base64", `${path}: content is not valid base64.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const cleanPath = (raw: string) => safePath(raw.replace(/^\/+/, ""));

/** Same safety rules as a zip entry: no zip-slip, no absolute or backslash paths, no duplicates, per-file and total limits. */
export function filesToMap(files: readonly SubmittedFile[]): FileMap {
  if (files.length > LIMITS.maxFiles) throw new InputError("too_many_files", `${files.length} files; the limit is ${LIMITS.maxFiles}.`);
  const map: FileMap = new Map();
  let total = 0;
  for (const file of files) {
    const path = cleanPath(file.path);
    if (map.has(path)) throw new InputError("duplicate_entry", `The file ${path} is listed twice.`);
    const bytes = (file.encoding ?? "utf8") === "base64" ? fromBase64(path, file.content) : new TextEncoder().encode(file.content);
    if (bytes.length > LIMITS.maxFileBytes) {
      throw new InputError("file_too_large", `${path} is ${(bytes.length / 1048576).toFixed(1)} MB; the per-file limit is 10 MB.`);
    }
    total += bytes.length;
    if (total > LIMITS.maxTotalBytes) throw new InputError("too_large", "The files add up to more than 100 MB.");
    map.set(path, bytes);
  }
  return map;
}

export interface PayloadStats {
  files: number;
  bytes: number;
  largest_file: { path: string; bytes: number } | null;
}

export function payloadStats(files: FileMap): PayloadStats {
  let bytes = 0;
  let largest: PayloadStats["largest_file"] = null;
  for (const [path, content] of files) {
    bytes += content.length;
    if (!largest || content.length > largest.bytes) largest = { path, bytes: content.length };
  }
  return { files: files.size, bytes, largest_file: largest };
}

/** What builders are told per upload_files call (Task 1 measurement); the server accepts up to UPLOAD_CALL_MAX_CHARS. */
export const UPLOAD_BATCH_CHARS = 20_000;
export const UPLOAD_CALL_MAX_CHARS = 65_536;
/** Per upload: base64 of the 30 MB archive cap, at most 4000 stored chunks, 5 open uploads per key. Bounds D1 growth and the memory takeUpload needs. */
export const UPLOAD_MAX_CHARS = Math.ceil((LIMITS.maxArchiveBytes * 4) / 3);
export const UPLOAD_MAX_CHUNKS = 4000;
export const UPLOAD_MAX_OPEN_PER_KEY = 5;
export const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

export const UPLOAD_CHUNK = SUBMITTED_FILE.extend({
  part: z.number().int().min(0).max(9999).default(0)
    .describe("0 for a whole file. A larger file is cut into consecutive pieces sent as part 0, 1, 2 ... (base64 may be cut anywhere)."),
});
export type UploadChunk = z.input<typeof UPLOAD_CHUNK>;

async function requireUpload(env: Pick<Env, "FACTORY">, keyId: string, uploadId: string): Promise<{ template_id: string; template_name: string }> {
  const row = await env.FACTORY.prepare("SELECT template_id, template_name FROM template_uploads WHERE upload_id = ?1 AND key_id = ?2")
    .bind(uploadId, keyId)
    .first<{ template_id: string; template_name: string }>();
  if (!row) throw new InputError("unknown_upload", "Unknown or expired upload_id. Call begin_upload again and resend the files.");
  return row;
}

export async function beginUpload(env: Pick<Env, "FACTORY">, keyId: string, templateId: string, templateName: string, now = Date.now()): Promise<string> {
  const stale = new Date(now - UPLOAD_TTL_MS).toISOString();
  const uploadId = `up_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM template_upload_chunks WHERE upload_id IN (SELECT upload_id FROM template_uploads WHERE created_at < ?1)").bind(stale),
    env.FACTORY.prepare("DELETE FROM template_uploads WHERE created_at < ?1").bind(stale),
  ]);
  const open = await env.FACTORY.prepare("SELECT count(*) AS n FROM template_uploads WHERE key_id = ?1").bind(keyId).first<{ n: number }>();
  if ((open?.n ?? 0) >= UPLOAD_MAX_OPEN_PER_KEY) {
    throw new InputError("too_many_uploads", `This key already has ${UPLOAD_MAX_OPEN_PER_KEY} open uploads. Finish one with finish_upload, or wait 6 hours for the oldest to expire.`);
  }
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO template_uploads (upload_id, key_id, template_id, template_name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(uploadId, keyId, templateId, templateName, new Date(now).toISOString()),
  ]);
  return uploadId;
}

async function uploadUsage(env: Pick<Env, "FACTORY">, uploadId: string): Promise<{ chars: number; chunks: number }> {
  const row = await env.FACTORY.prepare("SELECT coalesce(sum(length(content)), 0) AS chars, count(*) AS chunks FROM template_upload_chunks WHERE upload_id = ?1")
    .bind(uploadId)
    .first<{ chars: number; chunks: number }>();
  return { chars: row?.chars ?? 0, chunks: row?.chunks ?? 0 };
}

export async function addUploadChunks(env: Pick<Env, "FACTORY">, keyId: string, uploadId: string, chunks: readonly UploadChunk[]): Promise<{ chunks_stored: number; files: number }> {
  const chars = chunks.reduce((n, chunk) => n + chunk.content.length, 0);
  if (chars > UPLOAD_CALL_MAX_CHARS) {
    throw new InputError("batch_too_large", `This call carries ${chars} characters of content; send at most ${UPLOAD_BATCH_CHARS} per upload_files call.`);
  }
  await requireUpload(env, keyId, uploadId);
  const used = await uploadUsage(env, uploadId);
  if (used.chars + chars > UPLOAD_MAX_CHARS || used.chunks + chunks.length > UPLOAD_MAX_CHUNKS) {
    throw new InputError("upload_too_large", `An upload holds at most ${UPLOAD_MAX_CHARS} characters in ${UPLOAD_MAX_CHUNKS} chunks; this one would reach ${used.chars + chars} characters in ${used.chunks + chunks.length} chunks. A site this large breaks the 30 MB limit: reduce image sizes.`);
  }
  const statements = chunks.map((chunk) =>
    env.FACTORY.prepare("INSERT OR REPLACE INTO template_upload_chunks (upload_id, path, part, encoding, content) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(uploadId, cleanPath(chunk.path), chunk.part ?? 0, chunk.encoding ?? "utf8", chunk.content));
  const results = await env.FACTORY.batch([
    ...statements,
    env.FACTORY.prepare("SELECT count(*) AS chunks, count(DISTINCT path) AS files FROM template_upload_chunks WHERE upload_id = ?1").bind(uploadId),
  ]);
  const counts = results[results.length - 1]!.results[0] as { chunks: number; files: number };
  return { chunks_stored: counts.chunks, files: counts.files };
}

export async function takeUpload(env: Pick<Env, "FACTORY">, keyId: string, uploadId: string): Promise<{ template_id: string; template_name: string; files: SubmittedFile[] }> {
  const upload = await requireUpload(env, keyId, uploadId);
  const used = await uploadUsage(env, uploadId); // before loading any row, so an oversized upload cannot exhaust Worker memory
  if (used.chars > UPLOAD_MAX_CHARS) {
    throw new InputError("upload_too_large", `The upload holds ${used.chars} characters; the limit is ${UPLOAD_MAX_CHARS}. Reduce image sizes and start again with begin_upload.`);
  }
  const { results } = await env.FACTORY.prepare("SELECT path, part, encoding, content FROM template_upload_chunks WHERE upload_id = ?1 ORDER BY path, part")
    .bind(uploadId)
    .all<{ path: string; part: number; encoding: "utf8" | "base64"; content: string }>();
  const files = new Map<string, { encoding: "utf8" | "base64"; parts: string[] }>();
  for (const row of results) {
    const file = files.get(row.path) ?? { encoding: row.encoding, parts: [] };
    if (row.part !== file.parts.length) {
      throw new InputError("missing_part", `${row.path} is missing part ${file.parts.length}. Send it with upload_files, then call finish_upload again.`);
    }
    if (row.encoding !== file.encoding) throw new InputError("mixed_encoding", `${row.path} mixes utf8 and base64 parts; send every part with the same encoding.`);
    file.parts.push(row.content);
    files.set(row.path, file);
  }
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM template_upload_chunks WHERE upload_id = ?1").bind(uploadId),
    env.FACTORY.prepare("DELETE FROM template_uploads WHERE upload_id = ?1").bind(uploadId),
  ]);
  return { ...upload, files: [...files].map(([path, file]) => ({ path, encoding: file.encoding, content: file.parts.join("") })) };
}
