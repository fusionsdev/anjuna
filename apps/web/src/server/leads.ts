/**
 * Leads API (FUS-376), proxied to core's read-only admin routes. Core redacts PII and money by
 * `context.actor_role`; the panel only gates what the contract gates at endpoint level.
 *   GET /api/leads?...            -> LeadsResponse (employee and owner)
 *   GET /api/leads/export?...     -> CSV; `pii=1` is owner only
 *   GET /api/leads/:lead_id       -> GetLeadResponse (employee: applicant null)
 */
import {
  LEAD_EXPORT_COLUMNS,
  LEAD_EXPORT_PII_COLUMNS,
  LeadExportQuery,
  LeadExportResponse,
  LeadId,
  LeadsQuery,
  authorize,
  type AdminRequestContext,
} from "@anjuna/contracts";
import type { z } from "zod";
import { callCore, type CoreResult } from "./core.js";
import { csvRows } from "./csv.js";
import type { Env } from "./env.js";
import { decodePathSegment } from "./lifecycle.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fromCore = (r: CoreResult): Response => json(r.status, r.body);

const invalid = (error: z.ZodError, requestId: string): Response =>
  json(422, {
    error: "invalid",
    request_id: requestId,
    // An unrecognized_keys message names the key, and a key can be an email.
    issues: error.issues.map((i) => ({
      path: i.path.map(String).join("."),
      message: i.code === "unrecognized_keys" ? "Unrecognized query parameter" : i.message,
    })),
  });

export async function handleLeadsRoute(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  ctx: AdminRequestContext,
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const rid = ctx.request_id;

  if (path === "/api/leads") {
    const g = authorize("listLeads", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: rid });
    const q = LeadsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return invalid(q.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "listLeads", query: url.searchParams }));
  }

  if (path === "/api/leads/export") {
    const g = authorize("leadExport", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: rid });
    // Validation answers before the PII field group, as in the contract's check order.
    const q = LeadExportQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return invalid(q.error, rid);
    // A boolean: the parsed `pii` is the string "0" | "1", and "0" is truthy.
    const pii = q.data.pii === "1";
    const field = authorize("leadExport", ctx.actor_role, { pii });
    if (!field.ok) return json(403, { ...field.error, request_id: rid });

    const result = await callCore(env, ctx, { endpoint: "leadExport", query: url.searchParams });
    if (result.status !== 200) return fromCore(result);
    const body = LeadExportResponse.parse(result.body);
    // The columns follow the body and the file name follows the request, so the two must agree.
    if (body.pii !== pii) return json(502, { error: "bad_gateway", message: "core export pii does not match the request" });
    // Core resolves a missing bound and does not echo the window, so the name falls back.
    const window = q.data.from && q.data.to ? `${q.data.from}_${q.data.to}` : "export";
    const name = `leads-${window}${pii ? "-pii" : ""}.csv`;
    return new Response(csvRows(body.pii ? LEAD_EXPORT_PII_COLUMNS : LEAD_EXPORT_COLUMNS, body.rows), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
        "x-export-truncated": body.truncated ? "true" : "false",
      },
    });
  }

  const m = path.match(/^\/api\/leads\/([^/]+)$/);
  // `aggregates` is its own route in index.ts; never read it as a lead id.
  if (m && m[1] !== "aggregates") {
    const g = authorize("getLead", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: rid });
    const raw = decodePathSegment(m[1]!);
    const notFound = json(404, { error: "not_found", resource: "lead", request_id: rid });
    if (raw === null) return notFound;
    const id = LeadId.safeParse(raw);
    if (!id.success) return notFound;
    return fromCore(await callCore(env, ctx, { endpoint: "getLead", params: { lead_id: id.data } }));
  }

  return null;
}
