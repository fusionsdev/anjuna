import type { BrandConfig, BrandSummary } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { ConfigPanel } from "./ConfigPanel";

type Row = BrandSummary & { account: string };

export function BrandsScreen({ me }: { me: Me }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { brands } = await api.brands();
      // BrandSummary has no account; read it from each brand's config.
      const configs = await Promise.all(brands.map((b) => api.brand(b.brand_id)));
      const account = new Map(configs.map((c) => [c.brand_id, c.account]));
      setRows(brands.map((b) => ({ ...b, account: account.get(b.brand_id) ?? "—" })));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ");
    }
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <>
      <h1>แบรนด์ (Brands)</h1>
      {error && <div className="error">{error}</div>}
      {!rows ? (
        <div className="muted">กำลังโหลด…</div>
      ) : (
        <table className="table clickable">
          <thead>
            <tr>
              <th>โดเมน</th>
              <th>บัญชี</th>
              <th>สถานะ</th>
              <th>Form version</th>
              <th>A/B</th>
              <th className="num">Leads 7 วัน</th>
              <th className="num">Sold</th>
              <th className="num">Pending</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.brand_id} className={selected === b.brand_id ? "selected" : ""} onClick={() => setSelected(b.brand_id)}>
                <td>{b.hostnames[0]}</td>
                <td>{b.account}</td>
                <td>
                  <span className={`pill ${b.status}`}>{b.status === "live" ? "live" : "paused"}</span>
                </td>
                <td>
                  <code>{b.form_version ?? "—"}</code>
                </td>
                <td>{b.ab_config ? b.ab_config.variants.map((v) => `${v.id} ${v.weight}%`).join(" / ") : "ไม่มี"}</td>
                <td className="num">{b.stats_7d.leads}</td>
                <td className="num">{b.stats_7d.sold}</td>
                <td className="num">{b.stats_7d.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected && <ConfigPanel key={selected} me={me} brandId={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </>
  );
}

export type { BrandConfig };
