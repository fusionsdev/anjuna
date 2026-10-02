import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAdminRequest } from "./admin/index.js";
import { authenticateAccount } from "./auth.js";
import { handleConversionsAck, handleConversionsPending } from "./conversions.js";
import type { Env } from "./env.js";
import { json, notFound, unauthorized } from "./http.js";
import { handlePostback } from "./postback.js";

export type RpcHandler = (request: Request, env: Env, account: string) => Promise<Response>;

/** T6c registers POST routes here; only the test worker currently supplies an RPC route. */
export function createCoreHandler(rpcRoutes: ReadonlyMap<string, RpcHandler> = new Map()) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/health" && request.method === "GET") return json({ ok: true });
      if (pathname === "/api/postback" && ["GET", "POST"].includes(request.method)) {
        return handlePostback(request, env);
      }
      if (pathname === "/api/conversions/pending" && request.method === "GET") {
        return handleConversionsPending(request, env);
      }
      if (pathname === "/api/conversions/ack" && request.method === "POST") {
        return handleConversionsAck(request, env);
      }
      const rpc = pathname.startsWith("/rpc/") && request.method === "POST"
        ? rpcRoutes.get(pathname) : undefined;
      if (rpc) {
        const account = await authenticateAccount(request, env);
        return account === null ? unauthorized() : rpc(request, env, account);
      }
      // Includes every /admin/* request, regardless of Host/forwarded headers or credentials.
      return notFound();
    },
  };
}

/** Bind the panel to entrypoint "AdminService". Public fetch cannot reach this entrypoint. */
export class AdminService extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "core.aduplift.ai" || !pathname.startsWith("/admin/")) return notFound();
    return this.handleAdmin(request);
  }

  protected async handleAdmin(request: Request): Promise<Response> {
    return handleAdminRequest(request, this.env);
  }
}

export default createCoreHandler();
