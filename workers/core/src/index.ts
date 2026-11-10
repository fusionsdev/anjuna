import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAdminRequest } from "./admin/index.js";
import { analyticsRoutes } from "./analytics.js";
import { authenticateAccount } from "./auth.js";
import { handleScheduled } from "./cron.js";
import { handleConversionsAck, handleConversionsPending, handleConversionsRouting } from "./conversions.js";
import { handleSetupClaim, handleSetupPending, handleSetupResult } from "./conversion-setup.js";
import { handleDirectoryIngest, handleJobClaim, handleJobResult, handleJobsPending } from "./adkit.js";
import type { Env } from "./env.js";
import { json, notFound, unauthorized } from "./http.js";
import { handlePostback } from "./postback.js";
import { rpcRoutes } from "./rpc/index.js";
import { handleCampaignSpendIngest, handleSpendIngest } from "./spend.js";
import { handleFactoryLifecycleRequest, handlePanelLifecycleRequest } from "./lifecycle.js";

export { TrafficTail } from "./traffic-tail/do.js";
export type RpcHandler = (request: Request, env: Env, account: string, ctx?: ExecutionContext) => Promise<Response>;

/** The public entrypoint supplies the authenticated T6c RPC routes. */
export function createCoreHandler(rpcRoutes: ReadonlyMap<string, RpcHandler> = new Map()) {
  return {
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      await handleScheduled(controller, env);
    },

    async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/health" && request.method === "GET") return json({ ok: true });
      if (pathname === "/api/postback" && ["GET", "POST"].includes(request.method)) {
        return handlePostback(request, env, ctx);
      }
      if (pathname === "/api/conversions/pending" && request.method === "GET") {
        return handleConversionsPending(request, env);
      }
      if (pathname === "/api/conversions/ack" && request.method === "POST") {
        return handleConversionsAck(request, env);
      }
      if (pathname === "/api/conversions/routing" && request.method === "GET") {
        return handleConversionsRouting(request, env);
      }
      if (pathname === "/api/conversions/setup/pending" && request.method === "GET") return handleSetupPending(request, env);
      if (pathname === "/api/conversions/setup/claim" && request.method === "POST") return handleSetupClaim(request, env);
      if (pathname === "/api/conversions/setup/result" && request.method === "POST") return handleSetupResult(request, env);
      if (pathname === "/api/adkit/directory/ingest" && request.method === "POST") return handleDirectoryIngest(request, env);
      if (pathname === "/api/adkit/jobs/pending" && request.method === "GET") return handleJobsPending(request, env);
      if (pathname === "/api/adkit/jobs/claim" && request.method === "POST") return handleJobClaim(request, env);
      if (pathname === "/api/adkit/jobs/result" && request.method === "POST") return handleJobResult(request, env);
      if (pathname === "/api/spend/campaign-ingest" && request.method === "POST") return handleCampaignSpendIngest(request, env);
      if (pathname === "/api/spend/ingest" && request.method === "POST") {
        return handleSpendIngest(request, env);
      }
      // Brand Worker calls: /rpc/* and /analytics/*, both behind the per-account credential.
      const rpc = request.method !== "POST" ? undefined
        : pathname.startsWith("/rpc/") ? rpcRoutes.get(pathname) : analyticsRoutes.get(pathname);
      if (rpc) {
        const account = await authenticateAccount(request, env);
        return account === null ? unauthorized() : rpc(request, env, account, ctx);
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
