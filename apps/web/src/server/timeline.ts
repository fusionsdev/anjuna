// spec timeline (FUS-380): manual Google Ads account events on the brand timeline. Factory D1 only; the insert and its audit row share one batch.
import { BrandId, type AdminRequestContext } from "@anjuna/contracts";
import { AdsAccountEvent, CreateAdsEventRequest } from "../shared/timeline.js";
import { factoryAuditStatement } from "./audit.js";
import { callCore } from "./core.js";
import type { Env } from "./env.js";
import { decodePathSegment } from "./lifecycle.js";
import { authorizePanel } from "./panel-roles.js";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

const NOTE_MAX = 500;
const EARLIEST_OCCURRED_AT = "2020-01-01T00:00:00.000Z";
const FUTURE_SLACK_MS = 5 * 60_000;

interface Issue { path: string; message: string }

/** A factory `brands` row, else a brand core knows (an unmanaged brand has no factory row). */
export async function brandExists(env: Env, ctx: AdminRequestContext, brandId: string): Promise<"yes" | "no" | "core_error"> {
  const row = await env.FACTORY.prepare("SELECT 1 AS present FROM brands WHERE brand_id = ?1").bind(brandId).first();
  if (row) return "yes";
  const core = await callCore(env, ctx, { endpoint: "getBrand", params: { id: brandId } });
  if (core.status === 404) return "no";
  return core.status === 200 ? "yes" : "core_error";
}

const invalid = (ctx: AdminRequestContext, issues: Issue[]): Response =>
  json(422, { error: "invalid", request_id: ctx.request_id, issues });

async function createAdsEvent(request: Request, env: Env, ctx: AdminRequestContext, rawBrandId: string): Promise<Response> {
  const gate = authorizePanel("createAdsEvent", ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  const brandId = decodePathSegment(rawBrandId);
  if (brandId === null || !BrandId.safeParse(brandId).success) return json(400, { error: "invalid_brand_id" });

  const body: unknown = await request.json().catch(() => undefined);
  const parsed = CreateAdsEventRequest.safeParse(body);
  if (!parsed.success) {
    return invalid(ctx, parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })));
  }
  const { type, occurred_at } = parsed.data;
  const note = parsed.data.note.trim();
  const issues: Issue[] = [];
  if (note.length > NOTE_MAX) issues.push({ path: "note", message: `note must be at most ${NOTE_MAX} characters` });
  if (type === "other" && note === "") issues.push({ path: "note", message: "note is required when type is other" });
  const at = Date.parse(occurred_at);
  if (at < Date.parse(EARLIEST_OCCURRED_AT)) issues.push({ path: "occurred_at", message: `occurred_at must not be before ${EARLIEST_OCCURRED_AT}` });
  else if (at > Date.now() + FUTURE_SLACK_MS) issues.push({ path: "occurred_at", message: "occurred_at must not be more than 5 minutes in the future" });
  if (issues.length > 0) return invalid(ctx, issues);

  const exists = await brandExists(env, ctx, brandId);
  if (exists === "no") return json(404, { error: "not_found", resource: "brand" });
  if (exists === "core_error") return json(502, { error: "bad_gateway" });

  const event = AdsAccountEvent.parse({
    event_id: crypto.randomUUID(),
    brand_id: brandId,
    type,
    occurred_at,
    note,
    created_by: ctx.actor_id,
    created_role: ctx.actor_role,
    created_at: new Date().toISOString(),
  });
  try {
    await env.FACTORY.batch([
      env.FACTORY.prepare(
        `INSERT INTO ads_account_events (event_id, brand_id, type, occurred_at, note, created_by, created_role, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(event.event_id, event.brand_id, event.type, event.occurred_at, event.note, event.created_by, event.created_role, event.created_at),
      factoryAuditStatement(env.FACTORY, {
        actor_id: ctx.actor_id, actor_role: ctx.actor_role, action: "ads_event.create",
        entity_type: "brand", entity_id: brandId, after: event,
      }),
    ]);
  } catch {
    return json(500, { error: "internal", request_id: ctx.request_id });
  }
  return json(201, { event });
}

async function deleteAdsEvent(env: Env, ctx: AdminRequestContext, rawBrandId: string, rawEventId: string): Promise<Response> {
  const gate = authorizePanel("deleteAdsEvent", ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  const brandId = decodePathSegment(rawBrandId);
  if (brandId === null || !BrandId.safeParse(brandId).success) return json(400, { error: "invalid_brand_id" });
  const eventId = decodePathSegment(rawEventId);
  if (eventId === null) return json(404, { error: "not_found", resource: "ads_event" });

  const row = await env.FACTORY.prepare("SELECT * FROM ads_account_events WHERE event_id = ?1 AND brand_id = ?2")
    .bind(eventId, brandId).first();
  const stored = AdsAccountEvent.safeParse(row);
  if (!stored.success) return json(404, { error: "not_found", resource: "ads_event" });
  const event = stored.data;
  try {
    await env.FACTORY.batch([
      env.FACTORY.prepare("DELETE FROM ads_account_events WHERE event_id = ?1 AND brand_id = ?2").bind(eventId, brandId),
      factoryAuditStatement(env.FACTORY, {
        actor_id: ctx.actor_id, actor_role: ctx.actor_role, action: "ads_event.delete",
        entity_type: "brand", entity_id: brandId, before: event, after: null,
      }),
    ]);
  } catch {
    return json(500, { error: "internal", request_id: ctx.request_id });
  }
  return json(200, { deleted: event });
}

export async function handleTimelineRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  const collection = path.match(/^\/api\/brands\/([^/]+)\/ads-events$/);
  if (collection) {
    return request.method === "POST"
      ? createAdsEvent(request, env, ctx, collection[1]!)
      : json(405, { error: "method_not_allowed" });
  }
  const member = path.match(/^\/api\/brands\/([^/]+)\/ads-events\/([^/]+)$/);
  if (member) {
    return request.method === "DELETE"
      ? deleteAdsEvent(env, ctx, member[1]!, member[2]!)
      : json(405, { error: "method_not_allowed" });
  }
  return undefined;
}
