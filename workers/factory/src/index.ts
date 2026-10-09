import type { Env } from "./env.js";
import { InstallBrandWorkflow } from "./workflows/install.js";
import { RollbackBrandWorkflow } from "./workflows/rollback.js";
import { UpgradeAllWorkflow, upgradeWorkflowId } from "./workflows/upgrade-all.js";
import { isQueuedCompensationInstall, rejectQueuedInstall, setInstallStatus } from "./receipt.js";
import { recoverBrand } from "./workflows/recover.js";

export { InstallBrandWorkflow, RollbackBrandWorkflow, UpgradeAllWorkflow };

async function existingDispatch(db: D1Database, installId: string): Promise<"running" | "ready" | "rolled_back" | null> {
  const row = await db.prepare("SELECT status FROM installs WHERE install_id = ?").bind(installId).first<{ status: string }>();
  return row?.status === "running" || row?.status === "ready" || row?.status === "rolled_back"
    ? row.status
    : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const url = new URL(request.url);

    if (url.pathname === "/recover") {
      const input = await request.json<{ brand_id: string; started_by: string; started_role: string }>();
      if (typeof input.brand_id !== "string" || typeof input.started_by !== "string") return Response.json({ error: "invalid" }, { status: 400 });
      return recoverBrand(env, input);
    }

    // POST /install  { install_id, brand_id, revision_id }
    if (url.pathname === "/install") {
      const params = await request.json<{ install_id: string; brand_id: string; revision_id: string }>();
      const existing = await existingDispatch(env.FACTORY, params.install_id);
      if (existing) return Response.json({ ok: true, install_id: params.install_id, status: existing });
      let claimed = false;
      try {
        claimed = (await setInstallStatus(env.FACTORY, params.install_id, "running", undefined, params.brand_id)) === "claimed";
        await env.INSTALL_WORKFLOW.create({ id: params.install_id, params });
      } catch (error) {
        await rejectQueuedInstall(env.FACTORY, params.install_id, params.brand_id, String(error), claimed);
        return Response.json({ ok: false, error: "workflow_dispatch_failed", message: String(error) }, { status: 502 });
      }
      return Response.json({ ok: true, install_id: params.install_id });
    }

    // POST /rollback  { install_id, brand_id, to_revision_id }
    if (url.pathname === "/rollback") {
      const params = await request.json<{ install_id: string; brand_id: string; to_revision_id: string | null }>();
      const existing = await existingDispatch(env.FACTORY, params.install_id);
      if (existing) return Response.json({ ok: true, install_id: params.install_id, status: existing });
      let claimed = false;
      try {
        if (await isQueuedCompensationInstall(env.FACTORY, params.install_id)) {
          throw new Error("Queued compensation requires its exact original install");
        }
        claimed = (await setInstallStatus(env.FACTORY, params.install_id, "running", undefined, params.brand_id)) === "claimed";
        await env.ROLLBACK_WORKFLOW.create({ id: params.install_id, params });
      } catch (error) {
        await rejectQueuedInstall(env.FACTORY, params.install_id, params.brand_id, String(error), claimed);
        return Response.json({ ok: false, error: "workflow_dispatch_failed", message: String(error) }, { status: 502 });
      }
      return Response.json({ ok: true, install_id: params.install_id });
    }

    // POST /upgrade-all  { from_template_version_id, to_template_version_id, form_artifact_id, canary_brand_id, started_by, started_role }
    if (url.pathname === "/upgrade-all") {
      const params = await request.json<{
        from_template_version_id: string;
        to_template_version_id: string;
        form_artifact_id: string;
        canary_brand_id: string;
        started_by: string;
        started_role: "owner";
      }>();
      if (params.started_role !== "owner") {
        return Response.json({ ok: false, error: "owner_required" }, { status: 403 });
      }
      if (params.from_template_version_id === params.to_template_version_id) {
        return Response.json({ ok: false, error: "source_target_must_differ" }, { status: 400 });
      }
      const instanceId = await upgradeWorkflowId(params);
      await env.UPGRADE_WORKFLOW.create({ id: instanceId, params });
      return Response.json({ ok: true, instance_id: instanceId });
    }

    return new Response("Not Found", { status: 404 });
  },
};
