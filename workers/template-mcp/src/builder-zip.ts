/**
 * Public POST /submit-zip for builders that run on the user's machine (Open Design, Claude Code, Codex, Cursor):
 * the agent zips its static folder and sends it with curl and a builder key. Same pipeline and result as the
 * dashboard ZIP import, with the builder key as the submitter.
 */
import { TemplateZipImportRequest } from "@anjuna/contracts";
import { InputError } from "./archive";
import { authenticate } from "./auth";
import type { Env } from "./env";
import { issueList, json } from "./import-service";
import { submitTemplateZip } from "./submit";
import { readZipForm } from "./zip-form";

export async function handleBuilderZipSubmit(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  // The key is checked before the body is read, so an unauthenticated upload is never buffered.
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const { builder } = auth;
  let form: FormData;
  try {
    form = await readZipForm(request);
  } catch (error) {
    return json({ error: "invalid", message: error instanceof Error ? error.message : "Invalid ZIP upload" }, 422);
  }
  // Only the two named fields are read; any other form field is ignored.
  const parsed = TemplateZipImportRequest.safeParse({ template_id: form.get("template_id"), template_name: form.get("template_name") });
  if (!parsed.success) return json({ error: "invalid", issues: issueList(parsed.error) }, 422);
  const { template_id, template_name } = parsed.data;
  console.log(JSON.stringify({ event: "submit_template_payload", via: "http_submit_zip", template_id, key_id: builder.keyId }));
  try {
    const file = form.get("file") as File;
    return json(await submitTemplateZip(env, {
      template_id, template_name,
      submitted_by: { key_id: builder.keyId, label: builder.label }, created_by: builder.keyId,
      zip: new Uint8Array(await file.arrayBuffer()),
    }));
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.code, message: error.message }, 422);
    console.error("builder ZIP submit failed", error instanceof Error ? error.message : String(error));
    return json({ error: "internal" }, 500);
  }
}
