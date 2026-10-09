import { LatestUpgradeResponse, UpgradeAllCommand, upgradeInstallId, type UpgradeAllOutcome } from "@anjuna/contracts";

export async function latestUpgrade(db: D1Database): Promise<LatestUpgradeResponse> {
  const audit = await db.prepare("SELECT id,actor_id,after_json,created_at FROM audit_log WHERE action='upgrade.start' ORDER BY id DESC LIMIT 1")
    .first<{ id: number; actor_id: string; after_json: string; created_at: string }>();
  if (!audit) return { upgrade: null };
  const command = UpgradeAllCommand.parse({ ...JSON.parse(audit.after_json), started_by: audit.actor_id });
  const { results: brands } = await db.prepare(`SELECT b.brand_id,b.domain,b.status,r.template_version_id
    FROM brands b LEFT JOIN brand_revisions r ON r.revision_id=b.current_revision_id ORDER BY b.domain,b.brand_id`)
    .all<{ brand_id: string; domain: string; status: string; template_version_id: string | null }>();
  const ids = await Promise.all(brands.map((brand) => upgradeInstallId(command, brand.brand_id)));
  const canaryId = await upgradeInstallId(command, command.canary_brand_id);
  // A single read keeps canary and per-brand outcomes from different snapshots
  // from being combined. No core or factory network call is needed.
  // /api/installs/:id/retry of a terminal row inserts a fresh ins_ row and an
  // install.start audit entry with retry_of; follow that chain so each brand
  // shows its latest attempt for this command.
  const { results: installs } = await db.prepare(`WITH RECURSIVE chain(root,install_id,depth) AS (
      SELECT value,value,0 FROM json_each(?1)
      UNION ALL
      SELECT chain.root,a.entity_id,chain.depth+1 FROM audit_log a JOIN chain ON a.action='install.start' AND a.entity_type='install'
        AND json_extract(a.after_json,'$.retry_of')=chain.install_id WHERE chain.depth<50)
    SELECT chain.root,i.install_id,i.status,i.error FROM chain JOIN installs i ON i.install_id=chain.install_id
    WHERE i.kind='upgrade' ORDER BY chain.depth`)
    .bind(JSON.stringify([...new Set([...ids, canaryId])]))
    .all<{ root: string; install_id: string; status: UpgradeAllOutcome["status"]; error: string | null }>();
  // Rows arrive ordered by depth, so the last write per root is the latest retry.
  const byId = new Map(installs.map((row) => [row.root, row]));
  const canary = byId.get(canaryId);
  const canaryStopped = canary?.status === "failed" || canary?.status === "rolled_back";
  const canaryReady = canary?.status === "ready";
  const outcomes = brands.map((brand, index): UpgradeAllOutcome => {
    const row = byId.get(ids[index]!);
    const eligible = brand.status === "live" && brand.template_version_id === command.from_template_version_id;
    // A live source brand with no install row is only still waiting while the canary itself has not
    // reached `ready`. Once the canary is `ready` the workflow has committed the rest of the selection,
    // so such a brand was never part of this command (created later, or paused at acceptance).
    const waiting = !row && eligible && !canaryStopped && !canaryReady;
    return {
      brand_id: brand.brand_id, domain: brand.domain, is_canary: brand.brand_id === command.canary_brand_id,
      install_id: row?.install_id ?? null,
      retry_of: row && row.install_id !== row.root ? row.root : null,
      status: row?.status ?? (waiting ? "queued" : "skipped"),
      error: row?.error ?? (row ? null : waiting ? "Waiting for an install record" : canaryStopped && eligible ? "Canary stopped; no install recorded" : canaryReady && eligible ? "Canary reached ready; no install recorded for this command" : "No install recorded for this command"),
    };
  });
  return LatestUpgradeResponse.parse({ upgrade: { audit_id: audit.id, accepted_at: audit.created_at, command, outcomes } });
}
