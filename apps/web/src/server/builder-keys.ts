/**
 * Builder keys for the template MCP (factory D1 builder_keys). Replaces scripts/mint-key.mjs for staff keys.
 * The key is stored beside its SHA-256 hash and listed in the panel; the audit log holds only the label.
 */
import {
  BUILDER_KEY_PREFIX,
  BuilderKeyCreateRequest,
  BuilderKeyCreateResponse,
  BuilderKeyListResponse,
  BuilderKeySummary,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { writeFactoryAudit } from "./audit.js";
import type { Env } from "./env.js";
import { decodePathSegment } from "./lifecycle.js";
import { authorizePanel } from "./panel-roles.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const COLUMNS = "key_id, label, secret, created_by, created_at, last_used_at, revoked_at";

/** 32 random bytes, base64url without padding: the same format scripts/mint-key.mjs prints. */
function newSecret(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(byte);
  return BUILDER_KEY_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleBuilderKeyRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  const revoke = path.match(/^\/api\/builder-keys\/([^/]+)\/revoke$/);
  if (path !== "/api/builder-keys" && !revoke) return undefined;
  if (revoke) {
    if (!authorizePanel("manageBuilderKeys", ctx.actor_role).ok) return json(403, { error: "forbidden_role", required_role: "owner" });
  } else if (!authorizePanel("viewBuilderKeys", ctx.actor_role).ok) {
    return json(403, { error: "forbidden_role", required_role: "employee" });
  }

  if (path === "/api/builder-keys" && request.method === "GET") {
    const { results } = await env.FACTORY.prepare(`SELECT ${COLUMNS} FROM builder_keys ORDER BY created_at DESC, key_id`).all();
    return json(200, BuilderKeyListResponse.parse({ keys: results }));
  }

  if (path === "/api/builder-keys" && request.method === "POST") {
    const parsed = BuilderKeyCreateRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return json(422, { error: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
    }
    const secret = newSecret();
    const key = {
      key_id: `bk_${crypto.randomUUID()}`, label: parsed.data.label, secret, created_by: ctx.actor_id,
      created_at: new Date().toISOString(), last_used_at: null, revoked_at: null,
    };
    await env.FACTORY.prepare("INSERT INTO builder_keys (key_id, label, key_hash, secret, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(key.key_id, key.label, await sha256Hex(secret), secret, key.created_by, key.created_at)
      .run();
    await writeFactoryAudit(env.FACTORY, {
      actor_id: ctx.actor_id, actor_role: ctx.actor_role, action: "builder_key.create",
      entity_type: "builder_key", entity_id: key.key_id, after: { label: key.label },
    });
    return json(201, BuilderKeyCreateResponse.parse({ key }));
  }

  if (revoke && request.method === "POST") {
    const keyId = decodePathSegment(revoke[1]!);
    if (keyId === null) return json(404, { error: "not_found", resource: "builder_key" });
    const now = new Date().toISOString();
    const update = await env.FACTORY.prepare("UPDATE builder_keys SET revoked_at = ?2 WHERE key_id = ?1 AND revoked_at IS NULL").bind(keyId, now).run();
    const row = await env.FACTORY.prepare(`SELECT ${COLUMNS} FROM builder_keys WHERE key_id = ?1`).bind(keyId).first();
    if (!row) return json(404, { error: "not_found", resource: "builder_key" });
    if (update.meta.changes === 1) {
      await writeFactoryAudit(env.FACTORY, {
        actor_id: ctx.actor_id, actor_role: ctx.actor_role, action: "builder_key.revoke",
        entity_type: "builder_key", entity_id: keyId, after: { revoked_at: now },
      });
    }
    return json(200, { key: BuilderKeySummary.parse(row) });
  }

  return json(405, { error: "method_not_allowed" });
}
