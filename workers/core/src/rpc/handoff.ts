import { HANDOFF_TTL_SECONDS, type IssueHandoffRequest, type VerifyHandoffRequest } from "@anjuna/contracts";
import { sha256 } from "../auth.js";
import type { Env } from "../env.js";
import { json } from "../http.js";
import { randomToken, type RuntimeRow } from "./runtime.js";

const encoder = new TextEncoder();
interface Payload {
  brand_id: string; amount: number; zip: string; zip_hash: string; iat: number; nonce: string; kid: string;
}
function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("Noncanonical base64url");
  return bytes;
}
async function key(env: Env): Promise<CryptoKey> {
  if (!env.HANDOFF_KEY) throw new Error("Handoff key unavailable");
  return crypto.subtle.importKey("raw", encoder.encode(env.HANDOFF_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function keyId(env: Env): string {
  const id = env.HANDOFF_KEY_ID ?? "1";
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(id)) throw new Error("Invalid handoff key id");
  return id;
}

export async function issueHandoff(input: IssueHandoffRequest, env: Env, brand: RuntimeRow): Promise<Response> {
  const buckets: unknown = JSON.parse(brand.amount_buckets);
  if (!Array.isArray(buckets) || !buckets.includes(input.requested_amount)) return json({ error: "invalid" }, 400);
  const iat = Math.floor(Date.now() / 1000);
  // ZIP is also signed so verifyHandoff can return the contract's ZIP without server-side session state.
  const payload: Payload = { brand_id: input.brand_id, amount: input.requested_amount, zip: input.zip,
    zip_hash: await sha256(input.zip), iat, nonce: randomToken().slice(0, 16), kid: keyId(env) };
  const body = encode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await key(env), encoder.encode(body));
  return json({ token: `${body}.${encode(new Uint8Array(signature))}`,
    expires_at: new Date((iat + HANDOFF_TTL_SECONDS) * 1000).toISOString() });
}

export async function verifyHandoff(input: VerifyHandoffRequest, env: Env): Promise<Response> {
  const invalid = (reason: "malformed" | "bad_signature" | "expired" | "brand_mismatch") => json({ valid: false, reason });
  let payload: Payload;
  let signature: Uint8Array;
  const parts = input.token.split(".");
  if (parts.length !== 2) return invalid("malformed");
  const body = parts[0]!;
  try {
    payload = JSON.parse(new TextDecoder().decode(decode(body))) as Payload;
    signature = decode(parts[1]!);
    if (!payload || typeof payload.brand_id !== "string" ||
      !Number.isSafeInteger(payload.amount) || payload.amount <= 0 ||
      typeof payload.zip !== "string" || !/^\d{5}$/.test(payload.zip) ||
      typeof payload.zip_hash !== "string" || !/^[a-f0-9]{64}$/.test(payload.zip_hash) ||
      !Number.isSafeInteger(payload.iat) || typeof payload.kid !== "string" ||
      typeof payload.nonce !== "string" || !/^[a-f0-9]{16}$/.test(payload.nonce) || signature.length !== 32) return invalid("malformed");
  } catch { return invalid("malformed"); }
  if (payload.kid !== keyId(env) || !await crypto.subtle.verify("HMAC", await key(env), signature, encoder.encode(body))) {
    return invalid("bad_signature");
  }
  if (payload.zip_hash !== await sha256(payload.zip)) return invalid("bad_signature");
  if (payload.brand_id !== input.brand_id) return invalid("brand_mismatch");
  const now = Math.floor(Date.now() / 1000);
  if (payload.iat > now || payload.iat + HANDOFF_TTL_SECONDS <= now) return invalid("expired");
  return json({ valid: true, requested_amount: payload.amount, zip: payload.zip,
    expires_at: new Date((payload.iat + HANDOFF_TTL_SECONDS) * 1000).toISOString() });
}
