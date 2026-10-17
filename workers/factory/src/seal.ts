/**
 * Owner approval from the control panel: seal a certified template version. The caller (anjuna-web)
 * has already checked the session role; the factory checks it again and records the owner's user id.
 * The D1 work is the shared sealTemplateVersionRecord in @anjuna/factory-db, also used by template-mcp.
 */
import { sealTemplateVersionRecord, type SealFailure } from "@anjuna/factory-db";
import type { Env } from "./env.js";

export interface SealRequest {
  template_version_id: string;
  sealed_by: string;
  sealed_role: string;
}

type SealError = "owner_required" | SealFailure;
export type SealResponse =
  | { status: 200; body: { ok: true; template_version_id: string; sealed_by: string; sealed_at: string; already_sealed: boolean } }
  | { status: 403 | 404 | 409; body: { ok: false; error: SealError; message: string } };

export function parseSealRequest(input: unknown): SealRequest | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
  if (!valid(record.template_version_id) || !valid(record.sealed_by) || !valid(record.sealed_role)) return null;
  return { template_version_id: record.template_version_id, sealed_by: record.sealed_by, sealed_role: record.sealed_role };
}

export async function sealTemplate(env: Pick<Env, "FACTORY" | "ARTIFACTS">, input: SealRequest, now = new Date().toISOString()): Promise<SealResponse> {
  if (input.sealed_role !== "owner") {
    return { status: 403, body: { ok: false, error: "owner_required", message: "Only an owner can approve a template." } };
  }
  const outcome = await sealTemplateVersionRecord(env.FACTORY, env.ARTIFACTS, input, now);
  if (outcome.ok) return { status: 200, body: outcome };
  return { status: outcome.error === "not_found" ? 404 : 409, body: outcome };
}
