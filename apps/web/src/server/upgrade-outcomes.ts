import { LatestUpgradeResponse, UpgradeAllCommand, upgradeInstallId, upgradeRevisionId, type UpgradeAllOutcome } from "@anjuna/contracts";

export async function latestUpgrade(db: D1Database): Promise<LatestUpgradeResponse> {
  const audit = await db.prepare("SELECT id,actor_id,after_json,created_at FROM audit_log WHERE action='upgrade.start' ORDER BY id DESC LIMIT 1")
    .first<{ id: number; actor_id: string; after_json: string; created_at: string }>();
  if (!audit) return { upgrade: null };
  const command = UpgradeAllCommand.parse({ ...JSON.parse(audit.after_json), started_by: audit.actor_id });
  const { results: brands } = await db.prepare(`SELECT b.brand_id,b.domain,b.status,r.template_version_id
    FROM brands b LEFT JOIN brand_revisions r ON r.revision_id=b.current_revision_id ORDER BY b.domain,b.brand_id`)
    .all<{ brand_id: string; domain: string; status: string; template_version_id: string | null }>();
  const ids = await Promise.all(brands.map((brand) => upgradeInstallId(command, brand.brand_id)));
  const revisionIds = await Promise.all(brands.map((brand) => upgradeRevisionId(command, brand.brand_id)));
  const canaryId = await upgradeInstallId(command, command.canary_brand_id);
  // One D1 batch (a single snapshot) reads install rows and selection evidence, so canary, per-brand
  // outcomes and selection are never combined from different snapshots. No core or factory network call is needed.
  // The workflow's create_revisions step inserts one brand_revisions row per selected brand, with the
  // deterministic upgrade revision id, before the canary starts; that row is the proof of selection.
  // /api/installs/:id/retry of a terminal row inserts a fresh ins_ row and an
  // install.start audit entry with retry_of; follow that chain so each brand
  // shows its latest attempt for this command.
  const [installsResult, selectedResult] = await db.batch([db.prepare(`WITH RECURSIVE chain(root,install_id,depth) AS (
      SELECT value,value,0 FROM json_each(?1)
      UNION ALL
      SELECT chain.root,a.entity_id,chain.depth+1 FROM audit_log a JOIN chain ON a.action='install.start' AND a.entity_type='install'
        AND json_extract(a.after_json,'$.retry_of')=chain.install_id WHERE chain.depth<50)
    SELECT chain.root,i.install_id,i.status,i.error FROM chain JOIN installs i ON i.install_id=chain.install_id
    WHERE i.kind='upgrade' ORDER BY chain.depth`)
    .bind(JSON.stringify([...new Set([...ids, canaryId])])),
  db.prepare("SELECT revision_id FROM brand_revisions WHERE revision_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(revisionIds))]);
  const installs = (installsResult as D1Result<{ root: string; install_id: string; status: UpgradeAllOutcome["status"]; error: string | null }>).results;
  const selectedRevisions = new Set((selectedResult as D1Result<{ revision_id: string }>).results.map((row) => row.revision_id));
  // Rows arrive ordered by depth, so the last write per root is the latest retry.
  const byId = new Map(installs.map((row) => [row.root, row]));
  // The workflow gates the bulk step on the original deterministic canary row only. A retry of a failed
  // canary runs one individual install and never resumes the workflow, so the gate reads the original
  // row (install_id === canaryId), while the displayed canary outcome stays the latest retry.
  const gate = installs.find((row) => row.install_id === canaryId);
  const canaryStopped = gate?.status === "failed" || gate?.status === "rolled_back";
  const canaryPending = !gate;
  const outcomes = brands.map((brand, index): UpgradeAllOutcome => {
    const row = byId.get(ids[index]!);
    const selected = selectedRevisions.has(revisionIds[index]!);
    const eligible = brand.status === "live" && brand.template_version_id === command.from_template_version_id;
    // No install row yet: a brand the workflow selected is queued until the bulk step writes its row,
    // also after the canary is ready. Before the canary has an install row, create_revisions may not
    // have run yet, so live source brands read queued. A brand with no revision row was never selected.
    const waiting = !row && !canaryStopped && (selected || (canaryPending && eligible));
    return {
      brand_id: brand.brand_id, domain: brand.domain, is_canary: brand.brand_id === command.canary_brand_id,
      install_id: row?.install_id ?? null,
      retry_of: row && row.install_id !== row.root ? row.root : null,
      status: row?.status ?? (waiting ? "queued" : "skipped"),
      error: row?.error ?? (row ? null : waiting ? "Waiting for an install record" : canaryStopped && selected ? "Canary stopped; no install recorded" : "No install recorded for this command"),
    };
  });
  return LatestUpgradeResponse.parse({ upgrade: { audit_id: audit.id, accepted_at: audit.created_at, command, outcomes } });
}
