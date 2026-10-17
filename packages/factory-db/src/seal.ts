/**
 * The one D1 write that seals a certified template version. Both callers use it: the template-mcp
 * `seal_template_version` tool (after its OWNER_SECRET check) and the factory `/seal-template` route
 * (after its owner-role check). Authorization stays with the callers; this function checks the data.
 * A second call for a sealed version returns the stored seal and changes nothing.
 */

const SCREENSHOT_CHECKS = ["screenshot_desktop", "screenshot_mobile"] as const;

export type SealFailure = "not_found" | "not_certified" | "missing_evidence" | "certification_changed";

export type SealOutcome =
  | { ok: true; template_version_id: string; sealed_by: string; sealed_at: string; already_sealed: boolean }
  | { ok: false; error: SealFailure; message: string };

interface VersionRow {
  status: string;
  sealed_by: string | null;
  sealed_at: string | null;
}

const fail = (error: SealFailure, message: string): SealOutcome => ({ ok: false, error, message });

export async function sealTemplateVersionRecord(
  db: D1Database,
  artifacts: R2Bucket,
  input: { template_version_id: string; sealed_by: string },
  now: string = new Date().toISOString(),
): Promise<SealOutcome> {
  const id = input.template_version_id;
  const read = () =>
    db.prepare("SELECT status, sealed_by, sealed_at FROM template_versions WHERE template_version_id = ?1").bind(id).first<VersionRow>();
  const stored = (row: VersionRow): SealOutcome => ({
    ok: true,
    template_version_id: id,
    sealed_by: row.sealed_by ?? "",
    sealed_at: row.sealed_at ?? "",
    already_sealed: true,
  });

  const row = await read();
  if (!row) return fail("not_found", `template_version ${id} not found`);
  if (row.status === "sealed") return stored(row);
  if (row.status !== "certified") {
    return fail("not_certified", `Cannot seal: status is '${row.status}', expected 'certified'`);
  }

  // Only the latest result per check counts; an old pass cannot hide a failed re-run.
  const { results } = await db
    .prepare(`SELECT id, check_name, result, artifact_r2_key FROM certifications
      WHERE id IN (SELECT MAX(id) FROM certifications WHERE template_version_id = ?1 GROUP BY check_name)`)
    .bind(id)
    .all<{ id: number; check_name: string; result: string; artifact_r2_key: string | null }>();
  for (const name of SCREENSHOT_CHECKS) {
    const check = results.find((r) => r.check_name === name);
    if (check?.result !== "pass" || !check.artifact_r2_key) {
      return fail("missing_evidence", `Cannot seal: missing passing ${name} evidence. Re-run certification.`);
    }
    const artifact = await artifacts.head(check.artifact_r2_key);
    if (!artifact || artifact.size === 0 || artifact.httpMetadata?.contentType !== "image/png") {
      return fail("missing_evidence", `Missing PNG screenshot artifact: ${check.artifact_r2_key}. Re-run certification.`);
    }
  }

  const latest = Math.max(...results.map((r) => r.id));
  const [update] = await db.batch([
    db.prepare(`UPDATE template_versions SET status = 'sealed', sealed_by = ?2, sealed_at = ?3
      WHERE template_version_id = ?1 AND status = 'certified'
      AND (SELECT MAX(id) FROM certifications WHERE template_version_id = ?1) = ?4`)
      .bind(id, input.sealed_by, now, latest),
    db.prepare(`INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
      SELECT ?1, 'owner', 'template.seal', 'template_version', ?2, ?3, ?4, ?5 WHERE changes() > 0`)
      .bind(input.sealed_by, id, JSON.stringify({ status: "certified" }), JSON.stringify({ status: "sealed", sealed_by: input.sealed_by, sealed_at: now }), now),
  ]);
  if (update?.meta.changes) {
    return { ok: true, template_version_id: id, sealed_by: input.sealed_by, sealed_at: now, already_sealed: false };
  }
  // Lost a race: either someone else sealed it (return their seal) or the checks changed.
  const after = await read();
  if (after?.status === "sealed") return stored(after);
  return fail("certification_changed", "Cannot seal: certification changed. Retry after certification completes.");
}
