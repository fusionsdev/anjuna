import { LeadsRpc, type LeadsRpcMethod, type LeadsRpcRequest } from "@anjuna/contracts";
import { ownsBrand } from "../auth.js";
import type { RpcHandler } from "../index.js";
import { json } from "../http.js";
import { recordClick, zip } from "./clicks.js";
import { resolveContinuation } from "./continuations.js";
import { issueHandoff, verifyHandoff } from "./handoff.js";
import { getRuntime, ownsHostname, publicSettings } from "./runtime.js";
import { submitLead, validationEnv } from "./submit.js";
import { validateLeadPayload } from "./validation.js";

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 64_000) throw new RangeError();
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64_000) { await reader.cancel(); throw new RangeError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function handler<M extends LeadsRpcMethod>(method: M): RpcHandler {
  return async (request, env, account) => {
    const invalid = (message = "Invalid payload", status = 400) => method === "submitLead"
      ? json({ status: "invalid", message }, status) : json({ error: "invalid" }, status);
    let raw: Record<string, unknown>;
    try {
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
      raw = body as Record<string, unknown>;
    } catch (error) { return invalid(error instanceof RangeError ? "Payload too large" : "Invalid payload", error instanceof RangeError ? 413 : 400); }
    if (typeof raw.brand_id !== "string") return invalid();
    try {
      if (!await ownsBrand(env, account, raw.brand_id)) return json({ error: "forbidden_brand" }, 403);
      if (method === "submitLead") {
        if (new TextEncoder().encode(JSON.stringify(raw.lead) ?? "").length > 32_000) return invalid("Payload too large", 413);
        const validation = validateLeadPayload(raw.lead, validationEnv(env));
        if (!validation.ok) return invalid(validation.message);
      }
      const parsed = LeadsRpc[method].request.safeParse(raw);
      if (!parsed.success) return invalid();
      const brand = await getRuntime(env, raw.brand_id);
      if (!brand) return json({ error: "forbidden_brand" }, 403);
      if ("hostname" in parsed.data && (typeof parsed.data.hostname !== "string" || !ownsHostname(brand, parsed.data.hostname))) return json({ error: "forbidden_brand" }, 403);
      // The method and schema come from one registration; the casts only narrow the generic union.
      switch (method) {
        case "recordClick": return await recordClick(parsed.data as LeadsRpcRequest<"recordClick">, env);
        case "submitLead": return await submitLead(parsed.data as LeadsRpcRequest<"submitLead">, request, env);
        case "resolveContinuation": return await resolveContinuation(parsed.data as LeadsRpcRequest<"resolveContinuation">, env, brand);
        case "zip": return await zip(parsed.data as LeadsRpcRequest<"zip">, env);
        case "issueHandoff": return await issueHandoff(parsed.data as LeadsRpcRequest<"issueHandoff">, env, brand);
        case "verifyHandoff": return await verifyHandoff(parsed.data as LeadsRpcRequest<"verifyHandoff">, env);
        case "brandSettings": return json(publicSettings(brand, (parsed.data as LeadsRpcRequest<"brandSettings">).include_site_text === true));
        default: return json({ error: "not_found" }, 404);
      }
    } catch {
      // Never reflect SQL, configuration, PII or keys through a failed RPC.
      return method === "submitLead" ? json({ status: "error", message: "Please try again in a moment." }, 503)
        : json({ error: "internal" }, 503);
    }
  };
}

export const rpcRoutes: ReadonlyMap<string, RpcHandler> = new Map(
  (Object.keys(LeadsRpc) as LeadsRpcMethod[]).map((method) => [LeadsRpc[method].path, handler(method)]),
);
