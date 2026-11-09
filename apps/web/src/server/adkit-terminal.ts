/**
 * AdKit Terminal routes (T13-6, spec Part C). Owner only. The panel never calls AdKit and never runs a command: it
 * forwards one line to core, which parses it against the executor allowlist and queues a `terminal.run` job.
 *
 *   POST /api/adkit/terminal      owner  core POST /admin/adkit/terminal   { line, mode, dry_run?, confirm? }
 *   GET  /api/adkit/jobs/:id      owner  core GET  /admin/adkit/jobs/:id   masked output, at most 20 KB
 *
 * The owner role is checked here before core is called, and core checks it again, so an employee gets 403 from the
 * server whatever the UI shows. A refused line is 422 from core before any job row exists.
 */
import { TerminalRunRequest, authorize, type AdminRequestContext } from "@anjuna/contracts";
import { callCore, type CoreResult } from "./core.js";
import type { Env } from "./env.js";
import { decodePathSegment } from "./lifecycle.js";
import { authorizePanel } from "./panel-roles.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fromCore = (r: CoreResult): Response => json(r.status, r.body);

/** Both gates: the panel action, then core's endpoint role. Null when allowed. */
function denied(ctx: AdminRequestContext, endpoint: "createTerminalJob" | "getTerminalJob"): Response | null {
  const gate = authorizePanel("useTerminal", ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  const core = authorize(endpoint, ctx.actor_role);
  if (!core.ok) return json(403, { ...core.error, request_id: ctx.request_id });
  return null;
}

export async function handleAdkitTerminalRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  const { method } = request;

  if (path === "/api/adkit/terminal" && method === "POST") {
    const no = denied(ctx, "createTerminalJob");
    if (no) return no;
    const body = TerminalRunRequest.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      const issues = body.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "body", message: i.message }));
      return json(422, { error: "invalid", request_id: ctx.request_id, issues });
    }
    return fromCore(await callCore(env, ctx, { endpoint: "createTerminalJob", body: body.data }));
  }

  const m = path.match(/^\/api\/adkit\/jobs\/([^/]+)$/);
  if (m && method === "GET") {
    const no = denied(ctx, "getTerminalJob");
    if (no) return no;
    const id = decodePathSegment(m[1]!);
    if (id === null) return json(404, { error: "not_found", resource: "adkit_job", request_id: ctx.request_id });
    return fromCore(await callCore(env, ctx, { endpoint: "getTerminalJob", params: { id } }));
  }

  return undefined;
}
