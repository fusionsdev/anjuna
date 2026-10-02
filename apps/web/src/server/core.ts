/**
 * The panel's only way to reach core: the admin API contract over the CORE service binding (or
 * the mock behind MOCK_CORE=1). The acting user comes from the better-auth session, never from
 * the browser; every response is parsed with the contract schema, so an unexpected field (for
 * example a secret) turns into a 502 instead of reaching the browser.
 */
import {
  AdminApi,
  AdminError,
  adminContextToHeaders,
  type AdminEndpoint,
  type AdminRequestContext,
} from "@anjuna/contracts";
import type { Env } from "./env.js";
import { mockCoreFetch } from "./mock-core.js";

export interface CoreCall {
  endpoint: AdminEndpoint;
  params?: Record<string, string>;
  query?: URLSearchParams;
  body?: unknown;
}

export interface CoreResult {
  status: number;
  body: unknown;
}

const badGateway = (message: string): CoreResult => ({ status: 502, body: { error: "bad_gateway", message } });

export async function callCore(env: Env, ctx: AdminRequestContext, call: CoreCall): Promise<CoreResult> {
  const def = AdminApi[call.endpoint];
  let path: string = def.path;
  for (const [k, v] of Object.entries(call.params ?? {})) path = path.replace(`:${k}`, encodeURIComponent(v));
  const qs = call.query && [...call.query].length > 0 ? `?${call.query}` : "";

  const headers: Record<string, string> = adminContextToHeaders(ctx);
  const hasBody = def.method !== "GET";
  if (hasBody) headers["content-type"] = "application/json";
  const req = new Request(`https://core.internal${path}${qs}`, {
    method: def.method,
    headers,
    body: hasBody ? JSON.stringify(call.body ?? {}) : undefined,
  });

  let res: Response;
  try {
    if (env.MOCK_CORE === "1") {
      res = await mockCoreFetch(req);
    } else if (env.CORE) {
      res = await env.CORE.fetch(req);
    } else {
      throw new Error("CORE service binding is missing and MOCK_CORE is not 1");
    }
  } catch {
    return badGateway("core unreachable");
  }
  const payload: unknown = await res.json().catch(() => null);

  if (res.ok) {
    const parsed = def.response.safeParse(payload);
    return parsed.success ? { status: res.status, body: parsed.data } : badGateway("core response violates the admin contract");
  }
  const parsedErr = AdminError.safeParse(payload);
  return parsedErr.success ? { status: res.status, body: parsedErr.data } : badGateway("core error violates the admin contract");
}
