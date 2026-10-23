import { SuppressionReason, SuppressionSource, type SuppressionsResponse } from "@anjuna/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, api, type Me, type SuppressionFilterState } from "../api";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { NotFound } from "./NotFound";

// spec leads
const reasons: Record<SuppressionReason, [string, Tone]> = {
  blocklisted: ["บล็อก (Blocklisted)", "bad"],
  unsubscribed: ["ยกเลิกรับอีเมล (Unsubscribed)", "mute"],
  complaint: ["ร้องเรียน (Complaint)", "bad"],
  bounce: ["อีเมลตีกลับ (Bounce)", "warn"],
  manual: ["เพิ่มด้วยมือ (Manual)", "blue"],
};
const sources: Record<SuppressionSource, string> = { listmonk: "Listmonk", ses: "SES", manual: "ด้วยมือ (Manual)" };
type SuppressionRow = SuppressionsResponse["rows"][number];
const NO_FILTER: SuppressionFilterState = { q: "", reason: "", source: "" };
const message = (e: unknown) => e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ";
const fmt = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });

/** An employee never reaches the owner screen, so no hook of it runs and no request is made. */
export function SuppressionsScreen({ me }: { me: Me }) {
  if (me.role !== "owner") return <NotFound title="สำหรับ Owner เท่านั้น (Owner only)" hint="บัญชีพนักงานเปิดหน้านี้ไม่ได้ (An employee account cannot open this page.)" />;
  return <OwnerSuppressions />;
}

function OwnerSuppressions() {
  // Every request writes an audit row, so the search runs on submit, never per keystroke.
  // The values stay in component state: an email in the URL would reach browser history and proxy logs.
  const [filter, setFilter] = useState<SuppressionFilterState>(NO_FILTER);
  const [qDraft, setQDraft] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<SuppressionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPage(null); setError(null);
    api.suppressions(filter, cursor).then(
      (next) => { if (active) setPage(next); },
      (e: unknown) => { if (active) setError(message(e)); },
    );
    return () => { active = false; };
  }, [filter, cursor]);

  const update = (patch: Partial<SuppressionFilterState>) => { setFilter({ ...filter, ...patch }); setCursor(null); };
  const search = (e: FormEvent) => {
    e.preventDefault();
    const q = qDraft.trim();
    if (q !== filter.q) update({ q });
  };

  const columns: Column<SuppressionRow>[] = [
    { key: "email", header: "อีเมล (Email)", mono: true, cell: (r) => r.email },
    { key: "reason", header: "เหตุผล (Reason)", cell: (r) => { const [label, tone] = reasons[r.reason]; return <StatusBadge tone={tone} label={label} />; } },
    { key: "source", header: "แหล่งที่มา (Source)", cell: (r) => sources[r.source] },
    { key: "created", header: "สร้างเมื่อ (Created)", cell: (r) => fmt(r.created_at) },
    { key: "updated", header: "แก้ไขเมื่อ (Updated)", cell: (r) => r.updated_at ? fmt(r.updated_at) : "" },
  ];

  const filtered = Boolean(filter.q || filter.reason || filter.source);
  const empty = filtered
    ? <EmptyState title="ไม่พบอีเมลที่ตรงกับตัวกรอง (No suppressed email matches)" hint="ลองเปลี่ยนคำค้น เหตุผล หรือแหล่งที่มา (Try another search, reason or source)" />
    : <EmptyState title="ยังไม่มีอีเมลที่ถูกบล็อก (No suppressed emails yet)" />;

  return <>
    <div className="head">
      <h1>อีเมลที่บล็อก (Suppressions)</h1>
      <p className="sub">ทุกครั้งที่ค้นหา ระบบบันทึกลงบันทึกการตรวจสอบ (audit log) พร้อมชื่อของคุณ (Each search is recorded in the audit log under your name)</p>
    </div>
    <section className="panel" aria-label="ตัวกรองอีเมลที่บล็อก (Suppression filters)">
      <form onSubmit={search} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label>ค้นหาอีเมล (Search email)
          <input type="search" value={qDraft} maxLength={254} autoComplete="off" placeholder="ส่วนหนึ่งของอีเมล (Part of an email)" onChange={(e) => setQDraft(e.target.value)} />
        </label>
        <label>เหตุผล (Reason)
          <select value={filter.reason} onChange={(e) => update({ reason: e.target.value as SuppressionReason | "" })}>
            <option value="">ทุกเหตุผล (All)</option>
            {SuppressionReason.options.map((value) => <option key={value} value={value}>{reasons[value][0]}</option>)}
          </select>
        </label>
        <label>แหล่งที่มา (Source)
          <select value={filter.source} onChange={(e) => update({ source: e.target.value as SuppressionSource | "" })}>
            <option value="">ทุกแหล่ง (All)</option>
            {SuppressionSource.options.map((value) => <option key={value} value={value}>{sources[value]}</option>)}
          </select>
        </label>
        <button type="submit" className="btn" style={{ marginBottom: 8 }}>ค้นหา (Search)</button>
      </form>
    </section>
    <section className="panel" style={{ marginTop: 16 }} aria-label="รายการอีเมลที่บล็อก (Suppression list)">
      {error ? <p role="alert">{error}</p> : !page ? <Spinner /> : <>
        <DataTable label="รายการอีเมลที่บล็อก (Suppression list)" columns={columns} rows={page.rows} rowKey={(r) => r.email} empty={empty} />
        {page.next_cursor && <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={() => setCursor(page.next_cursor)}>ถัดไป (Next)</button></div>}
      </>}
    </section>
  </>;
}
