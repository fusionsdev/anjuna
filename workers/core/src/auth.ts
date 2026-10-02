import type { Env } from "./env.js";

export async function sha256(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Fixed-length SHA-256 hashes are compared with the runtime's constant-time primitive.
export function hashesEqual(actual: string, expected: string | null): boolean {
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(actual), encoder.encode(expected.toLowerCase()));
}

export function bearer(request: Request): string {
  return /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim() ?? "";
}

export async function authenticateAccount(request: Request, env: Env): Promise<string | null> {
  const token = bearer(request);
  if (!token) return null;
  const digest = await sha256(token);
  const { results } = await env.LEADS.prepare(
    "SELECT account, credential_hash FROM account_credentials",
  ).all<{ account: string; credential_hash: string }>();
  let account: string | null = null;
  // No account supplied by the caller is trusted; identity comes from the credential.
  for (const row of results) {
    if (hashesEqual(digest, row.credential_hash)) account = row.account;
  }
  return account;
}

export async function ownsBrand(env: Env, account: string, brandId: string): Promise<boolean> {
  return Boolean(await env.LEADS.prepare(
    "SELECT brand_id FROM brand_runtime WHERE brand_id = ?1 AND account = ?2",
  ).bind(brandId, account).first());
}

export async function drainAuthorized(request: Request, env: Env): Promise<boolean> {
  // V1 accepts a case-insensitive Bearer prefix, trims both sides, and is header-only.
  const raw = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const expected = env.DRAIN_TOKEN?.trim();
  return Boolean(raw && expected && hashesEqual(await sha256(raw), await sha256(expected)));
}
