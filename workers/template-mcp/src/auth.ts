import type { Env } from "./env";

export const DEFAULT_RATE_LIMIT = 60;
const WINDOW_SECONDS = 60;

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface BuilderIdentity {
  keyId: string;
  label: string;
}

export type AuthResult = { ok: true; builder: BuilderIdentity } | { ok: false; response: Response };

const reject = (status: number, error: string, headers: Record<string, string> = {}): AuthResult => ({
  ok: false,
  response: new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  }),
});

const KEY_PATTERN = /^\S{16,256}$/;

/**
 * The builder key from the request headers, first match wins:
 * `Authorization: Bearer <key>`, `Authorization: <key>`, `X-API-Key`, `Api-Key`.
 * Never read from the URL, which would leak into logs and referrers.
 */
export function extractApiKey(headers: Headers): string | null {
  const authorization = headers.get("authorization")?.trim() ?? "";
  const candidates = [/^Bearer\s+(.*)$/i.exec(authorization)?.[1] ?? authorization, headers.get("x-api-key"), headers.get("api-key")];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && KEY_PATTERN.test(value)) return value;
  }
  return null;
}

/**
 * Logs why a request was refused and the shape of the credential headers, so a builder that sends its key some other
 * way can be diagnosed from `wrangler tail`. Only the scheme, lengths and whitespace count are logged, never a value.
 */
function logAuthFailure(reason: string, headers: Headers): void {
  const authorization = headers.get("authorization");
  const scheme = authorization === null ? "absent" : /^Bearer\s/i.test(authorization.trim()) ? "bearer" : "other";
  const shape = (value: string | null) => (value === null ? null : { length: value.length, spaces: (value.match(/\s/g) ?? []).length });
  console.warn(
    JSON.stringify({
      event: "auth_failure",
      reason,
      authorization: { scheme, ...shape(authorization) },
      x_api_key: shape(headers.get("x-api-key")),
      api_key: shape(headers.get("api-key")),
    }),
  );
}

/** API key (see extractApiKey) -> builder identity (SHA-256 hash lookup in the factory D1), then the per-key rate limit. */
export async function authenticate(request: Request, env: Env, now = Date.now()): Promise<AuthResult> {
  const apiKey = extractApiKey(request.headers);
  const challenge = { "www-authenticate": 'Bearer realm="anjuna-template-mcp"' };
  if (!apiKey) {
    logAuthFailure("missing_or_malformed_api_key", request.headers);
    return reject(401, "missing_or_malformed_api_key", challenge);
  }
  const hash = await sha256Hex(apiKey);
  const row = await env.FACTORY.prepare("SELECT key_id, label, revoked_at FROM builder_keys WHERE key_hash = ?1")
    .bind(hash)
    .first<{ key_id: string; label: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) {
    logAuthFailure(row ? "revoked_api_key" : "invalid_api_key", request.headers);
    return reject(401, "invalid_api_key", challenge);
  }

  const limit = Math.max(1, Number.parseInt(env.RATE_LIMIT_PER_MINUTE ?? "", 10) || DEFAULT_RATE_LIMIT);
  const seconds = Math.floor(now / 1000);
  const windowStart = seconds - (seconds % WINDOW_SECONDS);
  const [counter] = await env.FACTORY.batch<{ requests: number }>([
    env.FACTORY.prepare(
      `INSERT INTO builder_key_usage (key_id, window_start, requests) VALUES (?1, ?2, 1)
       ON CONFLICT (key_id, window_start) DO UPDATE SET requests = requests + 1 RETURNING requests`,
    ).bind(row.key_id, windowStart),
    env.FACTORY.prepare("DELETE FROM builder_key_usage WHERE key_id = ?1 AND window_start < ?2").bind(row.key_id, windowStart - 3600),
    env.FACTORY.prepare("UPDATE builder_keys SET last_used_at = ?2 WHERE key_id = ?1").bind(row.key_id, new Date(now).toISOString()),
  ]);
  const used = counter?.results[0]?.requests ?? 1;
  if (used > limit) {
    return reject(429, "rate_limited", { "retry-after": String(windowStart + WINDOW_SECONDS - seconds) });
  }
  return { ok: true, builder: { keyId: row.key_id, label: row.label } };
}
