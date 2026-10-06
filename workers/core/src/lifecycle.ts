import {
  ApplyRuntimeRequest,
  adminContextFromHeaders,
  RuntimeStateRequest,
  RuntimeListRequest,
  type RuntimeListResponse,
  VerifySoldLeadRequest,
  type AdminRequestContext,
  type ApplyRuntimeResponse,
  type RuntimeStateResponse,
  type VerifySoldLeadResponse,
} from "@anjuna/contracts";
import { authenticateAccount } from "./auth.js";
import type { Env } from "./env.js";
import { json, notFound, unauthorized } from "./http.js";

const bad = (message: string, status = 422) => json({ error: "invalid", message }, status);
const forbidden = (message = "Forbidden") => json({ error: "forbidden", message }, 403);
const conflict = (message: string) => json({ error: "conflict", message }, 409);

interface RuntimeRow {
  brand_id: string;
  account: string;
  hostnames: string;
  drain_key: string;
  postback_token_hash: string | null;
  aid: string;
  prepop_base: string;
  amount_buckets: string;
  flow_gate_mode: string;
  paused: number;
  ab_config_json: string | null;
  keyword_default: string | null;
  form_route: string;
  form_version: string | null;
  applied_revision_id: string | null;
  last_lifecycle_install_id: string | null;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

async function body(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

async function applyRuntime(request: Request, env: Env, account: string): Promise<Response> {
  const parsed = ApplyRuntimeRequest.safeParse(await body(request));
  if (!parsed.success) return bad("Invalid runtime request");
  const input = parsed.data;
  if (input.account !== account) return forbidden("Credential account does not match request account");

  const current = await env.LEADS.prepare("SELECT * FROM brand_runtime WHERE brand_id = ?1")
    .bind(input.brand_id).first<RuntimeRow>();
  if (current && current.account !== account) return forbidden("Brand belongs to another account");
  if (current?.last_lifecycle_install_id === input.install_id) {
    const response: ApplyRuntimeResponse = {
      state: "noop", install_id: input.install_id,
      applied_revision_id: current.applied_revision_id, paused: Boolean(current.paused),
    };
    return json(response);
  }
  if (current && current.applied_revision_id !== input.expected_revision_id) {
    return conflict("Runtime revision is stale");
  }
  if (!current) {
    const factoryBrand = await env.FACTORY.prepare(
      "SELECT brand_id FROM brands WHERE brand_id = ?1 AND account = ?2",
    ).bind(input.brand_id, account).first<{ brand_id: string }>();
    if (!factoryBrand) return forbidden("Factory brand ownership is required for first provision");
    if (!input.initial_runtime) return bad("Initial runtime is required for first provision");
  }

  const timestamp = now();
  const detached = input.target_revision_id === null;
  const nextRevision = input.target_revision_id;
  const auditAfter = JSON.stringify({
    applied_revision_id: nextRevision,
    last_lifecycle_install_id: input.install_id,
    paused: detached,
  });
  const auditBefore = current ? JSON.stringify({
    applied_revision_id: current.applied_revision_id,
    last_lifecycle_install_id: current.last_lifecycle_install_id,
    paused: Boolean(current.paused),
  }) : null;

  if (!current) {
    const initial = input.initial_runtime!;
    await env.LEADS.prepare(`INSERT INTO brand_runtime
        (brand_id, account, hostnames, drain_key, postback_token_hash, aid, prepop_base,
         amount_buckets, flow_gate_mode, paused, keyword_default, form_route, form_version,
         applied_revision_id, last_lifecycle_install_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, 'param', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`)
        .bind(input.brand_id, account, JSON.stringify(input.hostnames), initial.drain_key,
          initial.aid, initial.prepop_base, JSON.stringify(initial.amount_buckets), detached ? 1 : 0,
          initial.keyword_default, initial.form_route, initial.form_version, nextRevision,
          input.install_id, timestamp).run();
    await env.FACTORY.prepare(`INSERT INTO audit_log
        (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
        VALUES (?1, ?2, 'lifecycle.runtime.apply', 'brand_runtime', ?3, ?4, ?5, ?6)`)
        .bind(input.actor_id, input.actor_role, input.brand_id, auditBefore, auditAfter, timestamp).run();
  } else {
    const nextFormVersion = input.initial_runtime?.form_version ?? current.form_version;
    const update = await env.LEADS.prepare(`UPDATE brand_runtime SET hostnames = ?1, form_version = ?2,
        applied_revision_id = ?3, last_lifecycle_install_id = ?4, paused = ?5, updated_at = ?6
        WHERE brand_id = ?7 AND applied_revision_id IS ?8 AND last_lifecycle_install_id IS NOT ?4`)
        .bind(JSON.stringify(input.hostnames), nextFormVersion, nextRevision, input.install_id,
          detached ? 1 : 0, timestamp, input.brand_id, input.expected_revision_id).run();
    // LEADS and FACTORY are separate D1 databases. The CAS update must win before we
    // append the Factory audit; a zero-row update is a competing/stale install, never applied.
    if (update.meta.changes !== 1) return conflict("Runtime revision is stale");
    // Cross-D1 writes cannot be atomic. If the migration-owned audit insert fails after
    // this point, the runtime remains applied and the request fails rather than claiming audit success.
    await env.FACTORY.prepare(`INSERT INTO audit_log
        (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
        VALUES (?1, ?2, 'lifecycle.runtime.apply', 'brand_runtime', ?3, ?4, ?5, ?6)`)
        .bind(input.actor_id, input.actor_role, input.brand_id, auditBefore, auditAfter, timestamp).run();
  }
  const response: ApplyRuntimeResponse = {
    state: detached ? "detached" : "applied", install_id: input.install_id,
    applied_revision_id: nextRevision, paused: detached,
  };
  return json(response);
}

async function runtimeState(request: Request, env: Env, account: string): Promise<Response> {
  const parsed = RuntimeStateRequest.safeParse(await body(request));
  if (!parsed.success) return bad("Invalid runtime-state request");
  if (parsed.data.account !== account) return forbidden("Credential account does not match request account");
  const row = await env.LEADS.prepare("SELECT * FROM brand_runtime WHERE brand_id = ?1")
    .bind(parsed.data.brand_id).first<RuntimeRow>();
  if (row && row.account !== account) return forbidden("Brand belongs to another account");
  if (!row) {
    const response: RuntimeStateResponse = { state: "absent", brand_id: parsed.data.brand_id, account, credential_account_match: true };
    return json(response);
  }
  const response: RuntimeStateResponse = {
    state: "applied", brand_id: row.brand_id, account,
    applied_revision_id: row.applied_revision_id, last_lifecycle_install_id: row.last_lifecycle_install_id,
    paused: Boolean(row.paused), bundle_form_version: row.form_version, credential_account_match: true,
  };
  return json(response);
}

async function runtimeList(env: Env, account: string): Promise<Response> {
  const { results } = await env.LEADS.prepare(`SELECT brand_id, account, hostnames, applied_revision_id,
      paused, form_version FROM brand_runtime WHERE account = ?1 ORDER BY brand_id`).bind(account).all<RuntimeRow>();
  const response: RuntimeListResponse = { brands: results.map((row) => ({
    brand_id: row.brand_id, account: row.account, hostnames: JSON.parse(row.hostnames),
    applied_revision_id: row.applied_revision_id, paused: Boolean(row.paused),
    bundle_form_version: row.form_version,
  })) };
  return json(response);
}

export async function handleFactoryLifecycleRequest(request: Request, env: Env): Promise<Response> {
  const account = await authenticateAccount(request, env);
  if (!account) return unauthorized();
  const pathname = new URL(request.url).pathname;
  if (request.method !== "POST") return notFound();
  if (pathname.endsWith("/runtime")) return applyRuntime(request, env, account);
  if (pathname.endsWith("/runtime-state")) return runtimeState(request, env, account);
  return notFound();
}

async function verifySold(request: Request, env: Env, context: AdminRequestContext): Promise<Response> {
  const parsed = VerifySoldLeadRequest.safeParse(await body(request));
  if (!parsed.success) return bad("Invalid Test-sold request");
  const row = await env.LEADS.prepare(`SELECT p.id, p.created_at
    FROM postback_events p JOIN leads l ON l.lead_id = p.lead_id
    WHERE p.lead_id = ?1 AND p.event_type = 'soldLead' AND l.brand = ?2 AND l.status = 'soldLead'
    ORDER BY p.created_at, p.id LIMIT 1`).bind(parsed.data.lead_id, parsed.data.brand_id)
    .first<{ id: number; created_at: string }>();
  if (!row) return notFound();
  const response: VerifySoldLeadResponse = { verified: true, event_id: String(row.id), event_at: row.created_at };
  void context;
  return json(response);
}

export async function handlePanelLifecycleRequest(request: Request, env: Env): Promise<Response> {
  const context = adminContextFromHeaders(request.headers);
  if (!context) return unauthorized();
  if (request.method !== "POST") return notFound();
  if (new URL(request.url).pathname.endsWith("/test-sold")) return verifySold(request, env, context);
  if (new URL(request.url).pathname.endsWith("/runtime-list")) {
    const parsed = RuntimeListRequest.safeParse(await body(request));
    if (!parsed.success) return bad("Invalid runtime-list request");
    const requestAccount = request.headers.get("x-lifecycle-account");
    if (!requestAccount || requestAccount !== parsed.data.account) return forbidden("Lifecycle account context does not match request account");
    if (env.LIFECYCLE_ACCOUNT && env.LIFECYCLE_ACCOUNT !== requestAccount) return forbidden("Lifecycle account is not configured for this tenant");
    // The panel binding is private; the BFF supplies the account in both the authenticated
    // request context and body so this handler never selects a tenant from an unbound body.
    return runtimeList(env, parsed.data.account);
  }
  return notFound();
}

