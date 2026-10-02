import type { AuditEntry } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";

const fmt = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });
const short = (v: Record<string, unknown> | null) => (v ? Object.entries(v).map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join(", ") : "—");

export function AuditScreen({ me }: { me: Me }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.audit().then((r) => setEntries(r.entries), (e) => setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ"));
  }, []);

  return (
    <>
      <h1>ประวัติการเปลี่ยนแปลง (Audit log)</h1>
      <p className="muted">{me.role === "owner" ? "แสดงทุกรายการ" : "แสดงเฉพาะรายการของคุณ"}</p>
      {error && <div className="error">{error}</div>}
      {!entries ? (
        <div className="muted">กำลังโหลด…</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>เวลา</th>
              <th>ผู้ทำ</th>
              <th>Action</th>
              <th>เป้าหมาย</th>
              <th>เดิม</th>
              <th>ใหม่</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{fmt(e.at)}</td>
                <td>
                  <span className={`pill ${e.actor_role}`}>{e.actor_role}</span> <span className="small muted">{e.actor_id}</span>
                </td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td>
                  {e.target.type}:{e.target.id}
                </td>
                <td className="small">{short(e.old)}</td>
                <td className="small">{short(e.new)}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">ยังไม่มีรายการ</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </>
  );
}
