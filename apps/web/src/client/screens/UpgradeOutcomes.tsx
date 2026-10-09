import type { LatestUpgradeResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api } from "../api";

export function UpgradeOutcomes({ refresh }: { refresh: number }) {
  const [result, setResult] = useState<LatestUpgradeResponse>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const next = await api.latestUpgrade();
        if (!active) return;
        setResult(next);
        setError(null);
        if (next.upgrade?.outcomes.some((row) => row.status === "queued" || row.status === "running")) {
          timer = setTimeout(() => void load(), 3000);
        }
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
          <td>{row.install_id ? <code>{row.install_id}</code> : "—"}</td>
          <td>{row.error ?? "—"}</td>
        </tr>)}</tbody>
      </table>
    </>}
  </section>;
}
