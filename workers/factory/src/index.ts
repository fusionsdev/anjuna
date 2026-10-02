import type { Env } from "./env.js";
import { InstallBrandWorkflow } from "./workflows/install.js";
import { RollbackBrandWorkflow } from "./workflows/rollback.js";
import { UpgradeAllWorkflow } from "./workflows/upgrade-all.js";

export { InstallBrandWorkflow, RollbackBrandWorkflow, UpgradeAllWorkflow };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const url = new URL(request.url);

    // POST /install  { install_id, brand_id, revision_id }
    if (url.pathname === "/install") {
      const params = await request.json<{ install_id: string; brand_id: string; revision_id: string }>();
      await env.INSTALL_WORKFLOW.create({ id: params.install_id, params });
      return Response.json({ ok: true, install_id: params.install_id });
    }

    // POST /rollback  { install_id, brand_id, to_revision_id }
    if (url.pathname === "/rollback") {
      const params = await request.json<{ install_id: string; brand_id: string; to_revision_id: string | null }>();
      await env.ROLLBACK_WORKFLOW.create({ id: params.install_id, params });
      return Response.json({ ok: true, install_id: params.install_id });
    }

    // POST /upgrade-all  { template_version_id, form_artifact_id, canary_brand_id, started_by }
    if (url.pathname === "/upgrade-all") {
      const params = await request.json<{
        template_version_id: string;
        form_artifact_id: string;
        canary_brand_id: string;
        started_by: string;
      }>();
      const instanceId = `upgrade-${params.template_version_id}-${Date.now()}`;
      await env.UPGRADE_WORKFLOW.create({ id: instanceId, params });
      return Response.json({ ok: true, instance_id: instanceId });
    }

    return new Response("Not Found", { status: 404 });
  },
};
