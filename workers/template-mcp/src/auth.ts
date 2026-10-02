import type { Env } from "./env";

export const DEFAULT_RATE_LIMIT = 60;
const WINDOW_SECONDS = 60;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
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

/** Bearer API key -> builder identity (SHA-256 hash lookup in the factory D1), then the per-key rate limit. */
export async function authenticate(request: Request, env: Env, now = Date.now()): Promise<AuthResult> {
  const match = /^Bearer\s+(\S{16,256})$/i.exec(request.headers.get("authorization") ?? "");
  const challenge = { "www-authenticate": 'Bearer realm="anjuna-template-mcp"' };
  if (!match) return reject(401, "missing_or_malformed_api_key", challenge);
  const hash = await sha256Hex(match[1]!);
  const row = await env.FACTORY.prepare("SELECT key_id, label, revoked_at FROM builder_keys WHERE key_hash = ?1")
    .bind(hash)
    .first<{ key_id: string; label: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) return reject(401, "invalid_api_key", challenge);

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
