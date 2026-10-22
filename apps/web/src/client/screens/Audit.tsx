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
      <h1 aria-label="ประวัติการเปลี่ยนแปลง (Audit log)">ประวัติการแก้ไข</h1>
      <p className="hint">ทุกการเปลี่ยนแปลงในระบบ ใครทำ ทำอะไร เมื่อไหร่</p>
      <p className="hint">{me.role === "owner" ? "แสดงทุกรายการ" : "แสดงเฉพาะรายการของคุณ"}</p>
      {error && <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>{error}</div>}
      {!entries ? (
        <div className="hint">กำลังโหลด…</div>
      ) : (
        <section className="panel" style={{ marginTop: 16 }}><div className="tw"><table>
          <thead>
            <tr>
              <th>เวลา</th>
              <th>ผู้ใช้</th>
              <th>สิทธิ์</th>
              <th>สิ่งที่ทำ</th>
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
                  <span style={{ overflowWrap: "anywhere" }}>{e.actor_id}</span>
                </td>
                <td>
                  <span className={`pill ${e.actor_role === "owner" ? "p-blue" : "p-mute"}`}>{e.actor_role === "owner" ? "Owner" : e.actor_role === "employee" ? "พนักงาน" : e.actor_role}</span>
                </td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td>
                  {e.target.type}:{e.target.id}
                </td>
                <td className="hint" style={{ minWidth: 180, overflowWrap: "anywhere" }}>{short(e.old)}</td>
                <td className="hint" style={{ minWidth: 180, overflowWrap: "anywhere" }}>{short(e.new)}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={7} className="hint">ยังไม่มีรายการ</td>
              </tr>
            )}
          </tbody>
        </table></div></section>
      )}
    </>
  );
}
