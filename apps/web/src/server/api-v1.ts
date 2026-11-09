/**
 * Panel API v1 (panel redesign Task 10): every wizard field through scoped keys, plus the AdKit reads and the
 * conversion action job that wizard step 4 uses.
 *
 *   GET  /api/api-keys                       owner: list keys (label, scopes, dates; never the key or its hash)
 *   POST /api/api-keys                       owner: mint a key; the response is the only place the key appears
 *   POST /api/api-keys/:id/revoke            owner
 *
 *   POST  /api/v1/brands/drafts              brand:draft       same body as POST /api/brands/drafts
 *   PATCH /api/v1/brands/:id/draft           brand:draft       same body as PATCH /api/brands/:id/draft
 *   GET   /api/v1/adkit/projects             adkit:read        core GET /admin/adkit/projects
 *   GET   /api/v1/adkit/projects/:p/accounts adkit:read        core GET /admin/adkit/projects/:p/accounts
 *   POST  /api/v1/adkit/conversion-actions   adkit:conversion  core POST /admin/adkit/jobs (idempotent)
 *   POST  /api/v1/brands/:id/generate        brand:generate    same checks and install path as /api/brands/:id/generate
 *   GET   /api/v1/ads/campaigns              ads:read          core GET /admin/adkit/campaigns (campaigns, caps in baht)
 *   POST  /api/v1/ads/campaigns              ads:draft         queues campaign.draft.create only; no body field can publish
 *   POST  /api/v1/ads/campaigns/:id/budget   ads:draft         queues campaign.update_budget (core checks the caps)
 *   POST  /api/v1/ads/campaigns/:id/enable   ads:enable        queues campaign.enable (core checks the caps); no default holder
 *   GET   /api/v1/ads/spend?brand=&from=&to= ads:read          core GET /admin/spend/rows: cost per brand, currency and allocation
 *
 * Auth: `Authorization: Bearer <key>` only. A key in the query string is refused with 400 before any lookup.
 * Without the header the panel session applies: an owner holds every scope, an employee only brand:draft, so
 * generate needs an owner session or a brand:generate key. A cookie write must come from the panel origin
 * (sessionWriteAllowed). Only an owner mints keys, and a key acts with the owner role inside its scopes; its key_id
 * is the actor in audit rows. No session holds `ads:enable` by default: only a key an owner minted with it enables. A key stops working when its creator is no longer an owner or is banned. The key is
 * hashed with SHA-256 like the builder keys and never logged, echoed or written to an audit row.
 */
import {
  AdkitJobCreateRequest, CampaignDraftPayload, DailyBudget, GoogleCampaignId, SpendRowsQuery, roleAtLeast, type AdminRequestContext,
} from "@anjuna/contracts";
import { z } from "zod";
import type { Auth } from "./auth.js";
import { callCore } from "./core.js";
import type { Env } from "./env.js";
import { createDraft, decodePathSegment, generateDraft, updateDraft } from "./lifecycle.js";
import { authorizePanel } from "./panel-roles.js";

export const API_KEY_PREFIX = "anj_api_";
export const API_KEY_SCOPES = ["brand:draft", "adkit:read", "adkit:conversion", "brand:generate", "ads:read", "ads:draft", "ads:enable"] as const;
export const ApiKeyScope = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

/** What an employee session may do on /api/v1. */
const EMPLOYEE_SCOPES: readonly ApiKeyScope[] = ["brand:draft"];
/** An owner session holds every scope except `ads:enable`, which only a key minted with it carries (the panel enables in the UI). */
const OWNER_SESSION_SCOPES: readonly ApiKeyScope[] = API_KEY_SCOPES.filter((s) => s !== "ads:enable");

/** Query parameter names a client might put a key in. Any of them, or a value that looks like a key, is refused. */
const KEY_PARAMS = new Set(["key", "api_key", "apikey", "token", "access_token", "bearer", "authorization"]);

const ApiKeyCreateRequest = z.strictObject({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(ApiKeyScope).min(1).max(API_KEY_SCOPES.length).refine((s) => new Set(s).size === s.length, "Duplicate scope"),
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const invalid = (error: z.ZodError) =>
  json(422, { error: "invalid", issues: error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });

/** 32 random bytes, base64url without padding, after the prefix: the builder key format with its own prefix. */
function newSecret(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(byte);
  return API_KEY_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Lowercase hex SHA-256, the builder key hashing (workers/template-mcp/src/auth.ts). */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ApiKeyRow { key_id: string; label: string; scopes_json: string; created_by: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
const SUMMARY_COLUMNS = "key_id, label, scopes_json, created_by, created_at, last_used_at, revoked_at";
const summary = (row: ApiKeyRow) => {
  const { scopes_json, ...rest } = row;
  return { ...rest, scopes: z.array(ApiKeyScope).catch([]).parse(JSON.parse(scopes_json)) };
};

async function audit(env: Env, ctx: AdminRequestContext, action: string, keyId: string, after: Record<string, unknown>): Promise<void> {
  await env.FACTORY.prepare("INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json, created_at) VALUES (?1, ?2, ?3, 'api_key', ?4, ?5, ?6)")
    .bind(ctx.actor_id, ctx.actor_role, action, keyId, JSON.stringify(after), new Date().toISOString()).run();
}

/** Key management for an owner session. Undefined when the path is not a key route. */
export async function handleApiKeyRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  const revoke = path.match(/^\/api\/api-keys\/([^/]+)\/revoke$/);
  if (path !== "/api/api-keys" && !revoke) return undefined;
  const gate = authorizePanel("manageApiKeys", ctx.actor_role);
  if (!gate.ok) return json(403, gate.error);
  if (!sessionWriteAllowed(request, env)) return json(403, { error: "cross_origin" });

  if (path === "/api/api-keys" && request.method === "GET") {
    const { results } = await env.FACTORY.prepare(`SELECT ${SUMMARY_COLUMNS} FROM api_keys ORDER BY created_at DESC, key_id`).all<ApiKeyRow>();
    return json(200, { keys: results.map(summary) });
  }
  if (path === "/api/api-keys" && request.method === "POST") {
    const parsed = ApiKeyCreateRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalid(parsed.error);
    const secret = newSecret();
    const row: ApiKeyRow = {
      key_id: `ak_${crypto.randomUUID().replaceAll("-", "")}`, label: parsed.data.label, scopes_json: JSON.stringify(parsed.data.scopes),
      created_by: ctx.actor_id, created_at: new Date().toISOString(), last_used_at: null, revoked_at: null,
    };
    await env.FACTORY.prepare("INSERT INTO api_keys (key_id, label, key_hash, scopes_json, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(row.key_id, row.label, await sha256Hex(secret), row.scopes_json, row.created_by, row.created_at).run();
    await audit(env, ctx, "api_key.create", row.key_id, { label: row.label, scopes: parsed.data.scopes });
    return json(201, { key: { ...summary(row), secret } });
  }
  if (revoke && request.method === "POST") {
    const keyId = decodePathSegment(revoke[1]!);
    if (keyId === null) return json(404, { error: "not_found", resource: "api_key" });
    const now = new Date().toISOString();
    const update = await env.FACTORY.prepare("UPDATE api_keys SET revoked_at = ?2 WHERE key_id = ?1 AND revoked_at IS NULL").bind(keyId, now).run();
    const row = await env.FACTORY.prepare(`SELECT ${SUMMARY_COLUMNS} FROM api_keys WHERE key_id = ?1`).bind(keyId).first<ApiKeyRow>();
    if (!row) return json(404, { error: "not_found", resource: "api_key" });
    if (update.meta.changes === 1) await audit(env, ctx, "api_key.revoke", keyId, { revoked_at: now });
    return json(200, { key: summary(row) });
  }
  return json(405, { error: "method_not_allowed" });
}

/**
 * CSRF guard for cookie-authenticated writes. A GET or HEAD passes. A write passes when the browser marks it
 * `Sec-Fetch-Site: same-origin`, or, without that header, when `Origin` is the panel origin (the request URL or
 * BETTER_AUTH_URL). A same-site or cross-site write and a write with neither header are refused. Bearer-key
 * requests never reach this check.
 */
export function sessionWriteAllowed(request: Request, env: Env): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const panel = new Set([new URL(request.url).origin]);
  try { panel.add(new URL(env.BETTER_AUTH_URL).origin); } catch { /* an unset URL adds nothing */ }
  return panel.has(origin);
}

interface Principal { ctx: AdminRequestContext; scopes: readonly ApiKeyScope[] }

/** The caller of a /api/v1 request, or the response that refuses it. */
async function principal(request: Request, env: Env, url: URL, auth: Auth): Promise<Principal | Response> {
  for (const [name, value] of url.searchParams) {
    if (KEY_PARAMS.has(name.toLowerCase()) || value.startsWith(API_KEY_PREFIX)) return json(400, { error: "key_in_query" });
  }
  const requestId = `req_${crypto.randomUUID()}`;
  const header = request.headers.get("authorization");
  if (header !== null) {
    const match = header.match(/^Bearer ([A-Za-z0-9_-]{1,200})$/);
    if (!match) return json(401, { error: "unauthorized" });
    const hash = await sha256Hex(match[1]!);
    const row = await env.FACTORY.prepare("SELECT key_id, scopes_json, created_by FROM api_keys WHERE key_hash = ?1 AND revoked_at IS NULL").bind(hash).first<{ key_id: string; scopes_json: string; created_by: string }>();
    if (!row) return json(401, { error: "unauthorized" });
    // A key acts with the owner role, so it stops working when its creator is no longer an owner or is banned.
    const creator = await env.AUTH.prepare(`SELECT "role", "banned" FROM "user" WHERE "id" = ?1`).bind(row.created_by).first<{ role: string; banned: number | null }>();
    if (!creator || creator.role !== "owner" || creator.banned) return json(401, { error: "unauthorized" });
    await env.FACTORY.prepare("UPDATE api_keys SET last_used_at = ?2 WHERE key_id = ?1").bind(row.key_id, new Date().toISOString()).run();
    const scopes = z.array(ApiKeyScope).catch([]).parse(JSON.parse(row.scopes_json));
    return { ctx: { actor_id: row.key_id, actor_role: "owner", request_id: requestId }, scopes };
  }
  const session = await auth.api.getSession({ headers: request.headers });
  const role = session?.user.role;
  if (!session || (role !== "owner" && role !== "employee")) return json(401, { error: "unauthorized" });
  if (!sessionWriteAllowed(request, env)) return json(403, { error: "cross_origin" });
  return {
    ctx: { actor_id: session.user.id, actor_role: role, request_id: requestId },
    scopes: roleAtLeast(role, "owner") ? OWNER_SESSION_SCOPES : EMPLOYEE_SCOPES,
  };
}

const ConversionActionRequest = AdkitJobCreateRequest.omit({ kind: true });
/** A campaign draft as a client sends it: account and project come from the brand in core, `kind` is fixed here. */
const CampaignDraftRequest = CampaignDraftPayload.omit({ account: true, project: true });
const CampaignBudgetRequest = z.strictObject({ daily_budget: DailyBudget });

/** /api/v1/*: always answers, 404 for an unknown path. */
export async function handleApiV1(request: Request, env: Env, url: URL, path: string, auth: Auth): Promise<Response> {
  const who = await principal(request, env, url, auth);
  if (who instanceof Response) return who;
  const { ctx, scopes } = who;
  const need = (scope: ApiKeyScope): Response | null => (scopes.includes(scope) ? null : json(403, { error: "forbidden_scope", required_scope: scope }));
  const method = request.method;
  let m: RegExpMatchArray | null;
  let denied: Response | null;

  if (path === "/api/v1/brands/drafts" && method === "POST") {
    if ((denied = need("brand:draft"))) return denied;
    return createDraft(request, env, ctx);
  }
  if ((m = path.match(/^\/api\/v1\/brands\/([^/]+)\/(draft|generate)$/))) {
    const brandId = decodePathSegment(m[1]!);
    if (m[2] === "draft" && method === "PATCH") {
      if ((denied = need("brand:draft"))) return denied;
      return brandId === null ? json(400, { error: "invalid_brand_id" }) : updateDraft(request, env, ctx, brandId);
    }
    if (m[2] === "generate" && method === "POST") {
      if ((denied = need("brand:generate"))) return denied;
      return brandId === null ? json(400, { error: "invalid_brand_id" }) : generateDraft(request, env, ctx, brandId);
    }
  }
  if (path === "/api/v1/adkit/projects" && method === "GET") {
    if ((denied = need("adkit:read"))) return denied;
    const r = await callCore(env, ctx, { endpoint: "adkitProjects" });
    return json(r.status, r.body);
  }
  if ((m = path.match(/^\/api\/v1\/adkit\/projects\/([^/]+)\/accounts$/)) && method === "GET") {
    if ((denied = need("adkit:read"))) return denied;
    const project = decodePathSegment(m[1]!);
    if (project === null) return json(404, { error: "not_found", resource: "route" });
    const r = await callCore(env, ctx, { endpoint: "adkitAccounts", params: { project } });
    return json(r.status, r.body);
  }
  if (path === "/api/v1/adkit/conversion-actions" && method === "POST") {
    if ((denied = need("adkit:conversion"))) return denied;
    const parsed = ConversionActionRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalid(parsed.error);
    const r = await callCore(env, ctx, { endpoint: "createAdkitJob", body: { kind: "conversion_action.create", ...parsed.data } });
    return json(r.status, r.body);
  }
  if (path === "/api/v1/ads/campaigns" && method === "GET") {
    if ((denied = need("ads:read"))) return denied;
    const r = await callCore(env, ctx, { endpoint: "listCampaigns" });
    return json(r.status, r.body);
  }
  if (path === "/api/v1/ads/campaigns" && method === "POST") {
    if ((denied = need("ads:draft"))) return denied;
    const parsed = CampaignDraftRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalid(parsed.error);
    const r = await callCore(env, ctx, { endpoint: "createCampaignJob", body: { kind: "campaign.draft.create", ...parsed.data } });
    return json(r.status, r.body);
  }
  if ((m = path.match(/^\/api\/v1\/ads\/campaigns\/([^/]+)\/(budget|enable)$/)) && method === "POST") {
    const action = m[2]!;
    if ((denied = need(action === "budget" ? "ads:draft" : "ads:enable"))) return denied;
    const raw = decodePathSegment(m[1]!);
    const campaignId = raw === null ? null : GoogleCampaignId.safeParse(raw);
    if (!campaignId?.success) return json(404, { error: "not_found", resource: "campaign" });
    if (action === "enable") {
      const r = await callCore(env, ctx, { endpoint: "createCampaignJob", body: { kind: "campaign.enable", campaign_id: campaignId.data } });
      return json(r.status, r.body);
    }
    const parsed = CampaignBudgetRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalid(parsed.error);
    const r = await callCore(env, ctx, { endpoint: "createCampaignJob", body: { kind: "campaign.update_budget", campaign_id: campaignId.data, ...parsed.data } });
    return json(r.status, r.body);
  }
  if (path === "/api/v1/ads/spend" && method === "GET") {
    if ((denied = need("ads:read"))) return denied;
    const query = SpendRowsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return invalid(query.error);
    const r = await callCore(env, ctx, { endpoint: "spendRows", query: url.searchParams });
    return json(r.status, r.body);
  }
  return json(404, { error: "not_found", resource: "route" });
}

