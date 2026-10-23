import type { AuditEntry } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";

const fmt = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });
const short = (v: Record<string, unknown> | null) => (v ? Object.entries(v).map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join(", ") : "—");
const diff = (v: Record<string, unknown> | null) => <span className="hint" style={{ display: "block", minWidth: 180, overflowWrap: "anywhere" }}>{short(v)}</span>;

const columns: Column<AuditEntry>[] = [
  { key: "at", header: "เวลา", cell: (e) => fmt(e.at) },
  { key: "actor", header: "ผู้ใช้", cell: (e) => <span style={{ overflowWrap: "anywhere" }}>{e.actor_id}</span>, mono: true },
  {
    key: "role",
    header: "สิทธิ์",
    cell: (e) => <span className={`pill ${e.actor_role === "owner" ? "p-blue" : "p-mute"}`}>{e.actor_role === "owner" ? "Owner" : e.actor_role === "employee" ? "พนักงาน" : e.actor_role}</span>,
  },
  { key: "action", header: "สิ่งที่ทำ", cell: (e) => e.action, mono: true },
  { key: "target", header: "เป้าหมาย", cell: (e) => `${e.target.type}:${e.target.id}` },
  { key: "old", header: "เดิม", cell: (e) => diff(e.old) },
  { key: "new", header: "ใหม่", cell: (e) => diff(e.new) },
];

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
        <Spinner />
      ) : (
        <section className="panel" style={{ marginTop: 16 }}>
          <DataTable label="ประวัติการแก้ไข" columns={columns} rows={entries} rowKey={(e) => String(e.id)} empty={<EmptyState title="ยังไม่มีรายการ" />} />
        </section>
      )}
    </>
  );
}
