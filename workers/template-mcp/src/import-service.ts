/**
 * Dashboard URL and ZIP imports: POST /submit-url and /submit-zip behind TemplateImportService. Only the
 * anjuna-web service binding reaches it; the public fetch handler never routes here.
 */
import { z } from "zod";
import type { TemplateThemeVarsResponse } from "@anjuna/contracts";
import { TemplateZipImportRequest } from "@anjuna/contracts";
import { readZipForm } from "./zip-form";
import { InputError, readZip } from "./archive";
import type { Env } from "./env";
import { assertPublicHttpsUrl } from "./input";
import { submitTemplateUrl, submitTemplateZip } from "./submit";
import { extractThemeVars } from "./theme-vars";

const ImportRequest = z.strictObject({
  url: z.string().url(),
  template_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  template_name: z.string().trim().min(1).max(128),
  submitted_by: z.strictObject({ key_id: z.null(), label: z.string().min(1).max(254) }),
  created_by: z.string().min(1).max(128),
});

const DetectRequest = z.strictObject({ template_version_id: z.string().min(1).max(128) });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Read-only: re-runs the color detector on the archive stored for a version. The owner reviews the map before saving it. */
async function detectThemeVars(request: Request, env: Env): Promise<Response> {
  const parsed = DetectRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "invalid", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, 422);
  }
  const { template_version_id } = parsed.data;
  const row = await env.FACTORY.prepare("SELECT r2_key FROM template_versions WHERE template_version_id = ?1").bind(template_version_id).first<{ r2_key: string }>();
  if (!row) return json({ error: "not_found" }, 404);
  try {
    const object = await env.ARTIFACTS.get(row.r2_key);
    if (!object) return json({ error: "template_zip_missing" }, 422);
    const theme_vars = extractThemeVars(readZip(new Uint8Array(await object.arrayBuffer())));
    return json({ template_version_id, theme_vars } satisfies TemplateThemeVarsResponse);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.code, message: error.message }, 422);
    console.error("theme vars detection failed", error instanceof Error ? error.message : String(error));
    return json({ error: "internal" }, 500);
  }
}

export async function handleImportRequest(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || !["/submit-url", "/submit-zip", "/detect-theme-vars"].includes(path)) return json({ error: "not_found" }, 404);
  if (path === "/detect-theme-vars") return detectThemeVars(request, env);
  if (path === "/submit-zip") {
    let form: FormData;
    try {
      form = await readZipForm(request);
    } catch (error) {
      return json({ error: "invalid", message: error instanceof Error ? error.message : "Invalid ZIP upload" }, 422);
    }
    let submittedBy: unknown;
    try { submittedBy = JSON.parse(String(form.get("submitted_by"))); } catch { submittedBy = null; }
    const parsed = TemplateZipImportRequest.extend({
      submitted_by: ImportRequest.shape.submitted_by,
      created_by: ImportRequest.shape.created_by,
    }).safeParse({ template_id: form.get("template_id"), template_name: form.get("template_name"), submitted_by: submittedBy, created_by: form.get("created_by") });
    if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, 422);
    try {
      const file = form.get("file") as File;
      return json(await submitTemplateZip(env, { ...parsed.data, zip: new Uint8Array(await file.arrayBuffer()) }));
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.code, message: error.message }, 422);
      console.error("template ZIP import failed", error instanceof Error ? error.message : String(error));
      return json({ error: "internal" }, 500);
    }
  }
  const parsed = ImportRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "invalid", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, 422);
  }
  try {
    // The URL pipeline reports unreachable sites as a rejected result; a malformed or non-public URL is a bad request here.
    assertPublicHttpsUrl(parsed.data.url);
    return json(await submitTemplateUrl(env, parsed.data));
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.code, message: error.message }, 422);
    console.error("template import failed", error instanceof Error ? error.message : String(error));
    return json({ error: "internal" }, 500);
  }
}
