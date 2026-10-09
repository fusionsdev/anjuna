import type { AdminRequestContext } from "@anjuna/contracts";

/** Queue one retry and preserve only the successful prefix of an uncompensated attempt. */
export async function queueInstallRetry(
  db: D1Database, sourceId: string, ctx: AdminRequestContext,
): Promise<string | null> {
  const terminal = await db.prepare("SELECT 1 FROM install_receipts WHERE install_id=? AND status IN ('failed','ok') LIMIT 1")
    .bind(sourceId).first();
  const now = new Date().toISOString();
  // One successor per receipted attempt, even if two requests overlap a fast failure.
  // Further retries use the successor's ID, keeping the original evidence intact.
  const digest = terminal ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceId)) : null;
  const retryId = digest
    ? `ins_retry_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}`
    : sourceId;
  const eligible = `status='failed'
    AND EXISTS (SELECT 1 FROM brands b WHERE b.brand_id=installs.brand_id
      AND b.status IN ('draft','live','failed') AND b.current_revision_id IS installs.from_revision_id)
    AND NOT EXISTS (SELECT 1 FROM installs active WHERE active.brand_id=installs.brand_id AND active.status IN ('queued','running'))`;
  const claim = terminal
    ? db.prepare(`INSERT OR IGNORE INTO installs
        (install_id,brand_id,kind,status,from_revision_id,to_revision_id,rollback_record_json,started_by,started_role,started_at)
        SELECT ?,brand_id,kind,'queued',from_revision_id,to_revision_id,rollback_record_json,started_by,started_role,?
        FROM installs WHERE install_id=? AND ${eligible}`)
      .bind(retryId, now, sourceId)
    : db.prepare(`UPDATE installs SET status='queued',error=NULL,finished_at=NULL WHERE install_id=? AND ${eligible}`)
      .bind(sourceId);
  const statements = [
    claim,
    db.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at)
      SELECT ?,?,?,'install',?,json_object('retry_of',?,'kind',kind,'brand_id',brand_id),? FROM installs WHERE install_id=? AND changes()=1`)
      .bind(ctx.actor_id, ctx.actor_role, terminal ? "install.start" : "install.retry", retryId, sourceId, now, sourceId),
  ];
  if (terminal) {
    statements.push(db.prepare(`INSERT INTO install_receipts (install_id,step,status,output_json,created_at)
      SELECT ?,step,status,output_json,created_at FROM install_receipts
      WHERE install_id=? AND status='ok' AND step!='rollback' AND changes()=1
        AND id < COALESCE((SELECT MIN(id) FROM install_receipts WHERE install_id=? AND status='failed'),9223372036854775807)`)
      .bind(retryId, sourceId, sourceId));
  }
  const [claimed] = await db.batch(statements);
  return claimed!.meta.changes === 1 ? retryId : null;
}
