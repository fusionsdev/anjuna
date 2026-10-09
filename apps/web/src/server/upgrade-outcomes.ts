import { LatestUpgradeResponse, UpgradeAllCommand, type UpgradeAllOutcome } from "@anjuna/contracts";

// Match the immutable identity written by the factory's upgrade-all workflow.
// Timestamps and target versions alone cannot separate overlapping commands.
async function installId(command: UpgradeAllCommand, brandId: string): Promise<string> {
  const parts = ["install", command.from_template_version_id, command.to_template_version_id,
    command.form_artifact_id, command.canary_brand_id, command.started_by, command.started_role, brandId];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return `upgrade-install-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function latestUpgrade(db: D1Database): Promise<LatestUpgradeResponse> {
  const audit = await db.prepare("SELECT id,actor_id,after_json,created_at FROM audit_log WHERE action='upgrade.start' ORDER BY id DESC LIMIT 1")
    .first<{ id: number; actor_id: string; after_json: string; created_at: string }>();
  if (!audit) return { upgrade: null };
  const command = UpgradeAllCommand.parse({ ...JSON.parse(audit.after_json), started_by: audit.actor_id });
  const { results: brands } = await db.prepare(`SELECT b.brand_id,b.domain,b.status,r.template_version_id
    FROM brands b LEFT JOIN brand_revisions r ON r.revision_id=b.current_revision_id ORDER BY b.domain,b.brand_id`)
    .all<{ brand_id: string; domain: string; status: string; template_version_id: string | null }>();
  const ids = await Promise.all(brands.map((brand) => installId(command, brand.brand_id)));
  const canaryId = await installId(command, command.canary_brand_id);
  // A single read keeps canary and per-brand outcomes from different snapshots
  // from being combined. No core or factory network call is needed.
  const { results: installs } = await db.prepare("SELECT install_id,status,error FROM installs WHERE kind='upgrade' AND install_id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify([...new Set([...ids, canaryId])]))
    .all<{ install_id: string; status: UpgradeAllOutcome["status"]; error: string | null }>();
  const byId = new Map(installs.map((row) => [row.install_id, row]));
  const canary = byId.get(canaryId);
  const canaryStopped = canary?.status === "failed" || canary?.status === "rolled_back";
  const outcomes = brands.map((brand, index): UpgradeAllOutcome => {
    const row = byId.get(ids[index]!);
    const eligible = brand.status === "live" && brand.template_version_id === command.from_template_version_id;
    const waiting = !row && eligible && !canaryStopped;
    return {
      brand_id: brand.brand_id, domain: brand.domain, is_canary: brand.brand_id === command.canary_brand_id,
      install_id: row?.install_id ?? null,
      status: row?.status ?? (waiting ? "queued" : "skipped"),
      error: row?.error ?? (row ? null : waiting ? "Waiting for an install record" : canaryStopped && eligible ? "Canary stopped; no install recorded" : "No install recorded for this command"),
    };
  });
  return LatestUpgradeResponse.parse({ upgrade: { audit_id: audit.id, accepted_at: audit.created_at, command, outcomes } });
}
