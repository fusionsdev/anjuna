/**
 * Suppression search (FUS-376), proxied to core's read-only admin route. Every row is an email, so
 * the route is owner only and core audits each search.
 *   GET /api/suppressions?q=&reason=&source=&limit=&cursor=  -> SuppressionsResponse (owner)
 */
import { SuppressionsQuery, authorize, type AdminRequestContext } from "@anjuna/contracts";
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
  if (request.method !== "GET" || path !== "/api/suppressions") return null;
  const rid = ctx.request_id;

  // The role gate answers before validation, so an employee learns nothing about the query.
  const g = authorize("listSuppressions", ctx.actor_role);
  if (!g.ok) return json(403, { ...g.error, request_id: rid });
  const q = SuppressionsQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!q.success) return invalid(q.error, rid);
  return fromCore(await callCore(env, ctx, { endpoint: "listSuppressions", query: url.searchParams }));
}
