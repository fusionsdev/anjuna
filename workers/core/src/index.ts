import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAdminRequest } from "./admin/index.js";
import { analyticsRoutes } from "./analytics.js";
import { authenticateAccount } from "./auth.js";
import { handleScheduled } from "./cron.js";
import { handleConversionsAck, handleConversionsPending } from "./conversions.js";
import type { Env } from "./env.js";
import { json, notFound, unauthorized } from "./http.js";
import { handlePostback } from "./postback.js";
import { rpcRoutes } from "./rpc/index.js";
import { handleFactoryLifecycleRequest, handlePanelLifecycleRequest } from "./lifecycle.js";

export type RpcHandler = (request: Request, env: Env, account: string) => Promise<Response>;

/** The public entrypoint supplies the authenticated T6c RPC routes. */
export function createCoreHandler(rpcRoutes: ReadonlyMap<string, RpcHandler> = new Map()) {
  return {
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      await handleScheduled(controller, env);
    },

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
      // Brand Worker calls: /rpc/* and /analytics/*, both behind the per-account credential.
      const rpc = request.method !== "POST" ? undefined
        : pathname.startsWith("/rpc/") ? rpcRoutes.get(pathname) : analyticsRoutes.get(pathname);
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

/** Private factory-only lifecycle binding; it is not reachable through public fetch. */
export class FactoryLifecycleService extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return handleFactoryLifecycleRequest(request, this.env);
  }
}

/** Private panel-only lifecycle binding; it is not reachable through public fetch. */
export class PanelLifecycleService extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return handlePanelLifecycleRequest(request, this.env);
  }
}

export default createCoreHandler(rpcRoutes);
