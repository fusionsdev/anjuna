import type { LatestUpgradeResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api } from "../api";

// Same cap as the single-install poll in BrandLifecycle: 120 polls x 3s = 6 minutes.
export const MAX_UPGRADE_POLLS = 120;

export function UpgradeOutcomes({ refresh }: { refresh: number }) {
  const [result, setResult] = useState<LatestUpgradeResponse>();
  const [error, setError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    setStalled(false);
    async function load() {
      try {
        const next = await api.latestUpgrade();
        if (!active) return;
        setResult(next);
        setError(null);
        if (!next.upgrade?.outcomes.some((row) => row.status === "queued" || row.status === "running")) return;
        if (polls >= MAX_UPGRADE_POLLS) { setStalled(true); return; }
        polls += 1;
        timer = setTimeout(() => void load(), 3000);
      } catch {
        if (active) setError("Could not load upgrade-all outcomes. Refresh to retry.");
      }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);

  return <section className="card upgrade-outcomes" aria-label="Latest upgrade-all outcomes">
    <h2>Latest upgrade-all outcomes</h2>
    {error && <p className="error" role="alert">{error}{result?.upgrade && " Showing previously loaded outcomes."}</p>}
    {stalled && <p className="error" role="alert">Auto-refresh stopped after 6 minutes. Some brands are still queued or running; the install may be stuck. Refresh to check again.</p>}
    {!result && !error && <p role="status">Loading upgrade-all outcomes…</p>}
    {result?.upgrade === null && <p>No accepted upgrade-all yet.</p>}
    {result?.upgrade && <>
      <p><code>{result.upgrade.command.from_template_version_id}</code> → <code>{result.upgrade.command.to_template_version_id}</code> · Accepted {result.upgrade.accepted_at}</p>
      <table className="table">
        <thead><tr><th>Brand</th><th>Role</th><th>Outcome</th><th>Install</th><th>Details</th></tr></thead>
        <tbody>{result.upgrade.outcomes.map((row) => <tr key={row.brand_id}>
          <th scope="row">{row.domain}<br /><code>{row.brand_id}</code></th>
          <td>{row.is_canary ? "Canary" : "—"}</td>
          <td>{row.status === "rolled_back" ? "rolled back" : row.status}</td>
          <td>{row.install_id ? <code>{row.install_id}</code> : "—"}{row.retry_of && <><br />Retry of <code>{row.retry_of}</code></>}</td>
          <td>{row.error ?? "—"}</td>
        </tr>)}</tbody>
      </table>
    </>}
  </section>;
}
