import type { Env } from "../env.js";
import { recoverySource } from "../receipt.js";

/** Recovery uses fresh rollback receipts and preserves the failed attempts. */
export async function recoverBrand(env: Env, input: {
  brand_id: string; started_by: string; started_role: string;
}): Promise<Response> {
  if (input.started_role !== "owner") return Response.json({ error: "owner_required" }, { status: 403 });
  const db = env.FACTORY;
  const brand = await db.prepare("SELECT status FROM brands WHERE brand_id=?").bind(input.brand_id).first<{ status: string }>();
  if (!brand) return Response.json({ error: "not_found" }, { status: 404 });
  // Dispatch failure copies evidence to the compensation row; only its source owns recovery.
  const original = await db.prepare(`SELECT install_id,status FROM installs i WHERE brand_id=? AND kind IN ('install','upgrade','rollback')
      AND ((status='failed' AND json_valid(error) AND json_extract(error,'$.recovery_required')=1
          AND json_extract(error,'$.original_install_id')=i.install_id)
        OR (status='rolled_back' AND EXISTS (SELECT 1 FROM installs r WHERE r.brand_id=i.brand_id
          AND r.status='rolled_back' AND json_valid(r.rollback_record_json)
          AND json_extract(r.rollback_record_json,'$.recovery_of')=i.install_id)))
      ORDER BY started_at DESC, rowid DESC LIMIT 1`)
    .bind(input.brand_id).first<{ install_id: string; status: string }>();
  if (original?.status === "rolled_back") {
    const completed = await db.prepare("SELECT install_id FROM installs WHERE brand_id=? AND status='rolled_back' AND json_valid(rollback_record_json) AND json_extract(rollback_record_json,'$.recovery_of')=? ORDER BY rowid DESC LIMIT 1")
      .bind(input.brand_id, original.install_id).first<{ install_id: string }>();
    if (completed) return Response.json({ ...completed, brand_id: input.brand_id, status: "rolled_back", idempotent: true });
  }
  const source = original && await recoverySource(db, original.install_id, input.brand_id);
  if (brand.status !== "installing" || !source) {
    return Response.json({ error: "recovery_not_required", message: "Recovery requires a failed install with failed compensation, or a failed rollback, and a retained lock" }, { status: 409 });
  }
  const installId = `recover-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const record = JSON.stringify({ recovery_of: original!.install_id });
  // This INSERT serializes requests without releasing the retained lock.
  const claim = await db.prepare(`INSERT INTO installs
    (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at,rollback_record_json)
    SELECT ?1,?2,'rollback','queued',(SELECT current_revision_id FROM brands WHERE brand_id=?2),?3,?4,'owner',?5,?6
    WHERE EXISTS (SELECT 1 FROM brands WHERE brand_id=?2 AND status='installing')
      AND EXISTS (SELECT 1 FROM installs WHERE install_id=?7 AND status='failed' AND error=?8)
      AND NOT EXISTS (SELECT 1 FROM installs WHERE brand_id=?2 AND status IN ('queued','running'))`)
    .bind(installId, input.brand_id, source.previous_revision_id, input.started_by, now, record, original!.install_id, source.error).run();
  if (claim.meta.changes !== 1) return Response.json({ error: "lifecycle_operation_active" }, { status: 409 });
  try {
    await db.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at)
      VALUES (?,'owner','install.recover','install',?,?,?)`)
      .bind(input.started_by, installId, JSON.stringify({ brand_id: input.brand_id, original_install_id: original!.install_id }), now).run();
    await env.ROLLBACK_WORKFLOW.create({ id: installId, params: {
      install_id: installId, brand_id: input.brand_id, original_install_id: original!.install_id,
      to_revision_id: source.previous_revision_id,
    } });
  } catch (error) {
    // Reconcile an uncertain create before permitting another recovery attempt.
    try {
      const instance = await env.ROLLBACK_WORKFLOW.get(installId);
      await instance.status();
    } catch {
      await db.prepare("UPDATE installs SET status='failed',error=?,finished_at=? WHERE install_id=? AND status='queued'")
        .bind(String(error), new Date().toISOString(), installId).run();
      return Response.json({ error: "workflow_dispatch_failed", install_id: installId }, { status: 502 });
    }
  }
  return Response.json({ install_id: installId, brand_id: input.brand_id, status: "queued" }, { status: 201 });
}
