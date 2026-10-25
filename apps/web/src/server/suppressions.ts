/**
 * Suppressions (FUS-376 search, FUS-382 writes), proxied to core's admin routes. Every row is an
 * email, so the routes are owner only; the address travels in the body, never in a URL or log.
 *   GET  /api/suppressions?q=&reason=&source=&added_by=&limit=&cursor=  -> SuppressionsResponse
 *   POST /api/suppressions           { email, reason? } -> 201 row (409 on a known address)
 *   POST /api/suppressions/remove   { email }           -> 200 { removed: true } (404 unknown)
 */
import {
  AddSuppressionRequest,
  RemoveSuppressionRequest,
  SuppressionsQuery,
  authorize,
  type AdminRequestContext,
} from "@anjuna/contracts";
import type { z } from "zod";
import { callCore, type CoreResult } from "./core.js";
import type { Env } from "./env.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fromCore = (r: CoreResult): Response => json(r.status, r.body);

// Paths and messages only: an issue never carries the input, so `q` stays out of the body.
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

export async function handleSuppressionsRoute(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  ctx: AdminRequestContext,
): Promise<Response | null> {
  const rid = ctx.request_id;

  if (request.method === "GET" && path === "/api/suppressions") {
    // The role gate answers before validation, so an employee learns nothing about the query.
    const g = authorize("listSuppressions", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: rid });
    const q = SuppressionsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return invalid(q.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "listSuppressions", query: url.searchParams }));
  }

  if (request.method === "POST" && path === "/api/suppressions") {
    const g = authorize("addSuppression", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: rid });
    const b = AddSuppressionRequest.safeParse(await request.json().catch(() => ({})));
    if (!b.success) return invalid(b.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "addSuppression", body: b.data }));
  }

  if (request.method === "POST" && path === "/api/suppressions/remove") {
    const g = authorize("removeSuppression", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: rid });
    const b = RemoveSuppressionRequest.safeParse(await request.json().catch(() => ({})));
    if (!b.success) return invalid(b.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "removeSuppression", body: b.data }));
  }

  return null;
}
