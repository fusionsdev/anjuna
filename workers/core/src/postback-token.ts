import { sha256 } from "./auth.js";
import type { Env } from "./env.js";

/** LeadsGate global postback: one secret per tenant core (V1 parity). Short or blank secrets count as unset. */
export const MIN_GLOBAL_POSTBACK_TOKEN_LENGTH = 32;

export async function globalPostbackDigest(env: Env): Promise<string | null> {
  const value = env.POSTBACK_TOKEN?.trim() ?? "";
  return value.length >= MIN_GLOBAL_POSTBACK_TOKEN_LENGTH ? sha256(value) : null;
}
