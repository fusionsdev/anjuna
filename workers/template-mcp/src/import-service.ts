/**
 * Dashboard "Import from URL": POST /submit-url behind the TemplateImportService entrypoint. Only the
 * anjuna-web service binding reaches it; the public fetch handler never routes here.
 */
import { z } from "zod";
import { InputError } from "./archive";
import type { Env } from "./env";
import { assertPublicHttpsUrl } from "./input";
import { submitTemplateUrl } from "./submit";

const ImportRequest = z.strictObject({
  url: z.string().url(),
  template_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  template_name: z.string().trim().min(1).max(128),
  submitted_by: z.strictObject({ key_id: z.null(), label: z.string().min(1).max(254) }),
  created_by: z.string().min(1).max(128),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleImportRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/submit-url") return json({ error: "not_found" }, 404);
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
