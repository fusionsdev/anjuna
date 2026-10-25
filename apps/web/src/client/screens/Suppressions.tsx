// spec polish D7.1
import { SuppressionReason, SuppressionSource, type SuppressionsResponse } from "@anjuna/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, api, type Me, type PanelUser, type SuppressionFilterState } from "../api";
import { useConfirm } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
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
const NO_FILTER: SuppressionFilterState = { q: "", reason: "", source: "", added_by: "" };

function addedByCell(row: SuppressionRow, usersById: Map<string, PanelUser>) {
  if (row.added_by === null) return <span>ระบบ (sync)</span>;
  const user = usersById.get(row.added_by);
  if (user) return <span>{user.name}</span>;
  return <code title="ผู้ใช้ที่ถูกลบ (Deleted user)" style={{ fontSize: "0.85em", overflowWrap: "anywhere" }}>{row.added_by}</code>;
}
// Keyed on the HTTP status only: ApiError.thai and the body can echo the searched email, so this screen never renders them.
const MESSAGES: Record<number, string> = {
  401: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง (Session expired)",
  403: "สิทธิ์ไม่เพียงพอ (ต้องเป็น Owner)",
  422: "ค่าค้นหาไม่ถูกต้อง (Invalid search)",
};
const message = (e: unknown) => (e instanceof ApiError ? MESSAGES[e.status] : undefined) ?? "ค้นหาไม่สำเร็จ (Search failed)";
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
  const [reloadSeq, setReloadSeq] = useState(0);
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [addEmail, setAddEmail] = useState("");
  const [addReason, setAddReason] = useState<SuppressionReason>("manual");
  const [confirm, confirmDialog] = useConfirm();

  // The user list maps added_by ids to names for the column and the actor select.
  // When it fails or is not loaded yet, the column falls back to the raw id.
  useEffect(() => {
    let active = true;
    api.users().then(
      (list) => { if (active) setUsers(list); },
      () => { if (active) setUsers([]); },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setPage(null); setError(null);
    api.suppressions(filter, cursor).then(
      (next) => { if (active) setPage(next); },
      (e: unknown) => { if (active) setError(message(e)); },
    );
    return () => { active = false; };
  }, [filter, cursor, reloadSeq]);

  const update = (patch: Partial<SuppressionFilterState>) => { setFilter({ ...filter, ...patch }); setCursor(null); };
  const search = (e: FormEvent) => {
    e.preventDefault();
    const q = qDraft.trim();
    if (q !== filter.q || error !== null) update({ q });
  };
  const usersById = new Map(users.map((u) => [u.id, u]));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const email = addEmail.trim();
    if (!email) return;
    setToast(null);
    try {
      await api.addSuppression({ email, reason: addReason });
      setToast({ kind: "ok", text: `เพิ่ม ${email} แล้ว (Added ${email})` });
      setAddEmail("");
      setReloadSeq((n) => n + 1);
    } catch (err) {
      setToast({ kind: "err", text: err instanceof ApiError ? err.thai : "เพิ่มไม่สำเร็จ (Could not add)" });
    }
  };

  const remove = async (row: SuppressionRow) => {
    const ok = await confirm({
      title: `ลบ ${row.email} (Remove ${row.email})?`,
      body: "ถ้า Listmonk ยังบล็อกอีเมลนี้ แถวจะกลับมาอีกในการซิงก์ครั้งถัดไป (A Listmonk row comes back on the next sync if Listmonk still blocks the address)",
      confirmLabel: "ลบ (Remove)",
      tone: "danger",
    });
    if (!ok) return;
    setToast(null);
    try {
      await api.removeSuppression(row.email);
      setToast({ kind: "ok", text: `ลบ ${row.email} แล้ว (Removed ${row.email})` });
      setReloadSeq((n) => n + 1);
    } catch (err) {
      setToast({ kind: "err", text: err instanceof ApiError ? err.thai : "ลบไม่สำเร็จ (Could not remove)" });
    }
  };

  const columns: Column<SuppressionRow>[] = [
    { key: "email", header: "อีเมล (Email)", mono: true, cell: (r) => r.email },
    { key: "reason", header: "เหตุผล (Reason)", cell: (r) => { const [label, tone] = reasons[r.reason]; return <StatusBadge tone={tone} label={label} />; } },
    { key: "source", header: "แหล่งที่มา (Source)", cell: (r) => sources[r.source] },
    { key: "created", header: "สร้างเมื่อ (Created)", cell: (r) => fmt(r.created_at) },
    { key: "updated", header: "แก้ไขเมื่อ (Updated)", cell: (r) => r.updated_at ? fmt(r.updated_at) : "" },
    { key: "added_by", header: "เพิ่มโดย (Added by)", cell: (r) => addedByCell(r, usersById) },
    { key: "actions", header: "การจัดการ (Actions)", cell: (r) => <button type="button" className="btn danger" onClick={() => remove(r)}>ลบ (Remove)</button> },
  ];

  const filtered = Boolean(filter.q || filter.reason || filter.source || filter.added_by);
  const empty = filtered
    ? <EmptyState title="ไม่พบอีเมลที่ตรงกับตัวกรอง (No suppressed email matches)" hint="ลองเปลี่ยนคำค้น เหตุผล แหล่งที่มา หรือผู้เพิ่ม (Try another search, reason, source or actor)" />
    : <EmptyState title="ยังไม่มีอีเมลที่ถูกบล็อก (No suppressed emails yet)" />;

  return <>
    <div className="head">
      <h1>อีเมลที่บล็อก (Suppressions)</h1>
      <p className="sub">ทุกครั้งที่ค้นหา ระบบบันทึกลงบันทึกการตรวจสอบ (audit log) พร้อมชื่อของคุณ (Each search is recorded in the audit log under your name)</p>
    </div>
    {toast && <Toast kind={toast.kind} text={toast.text} onDismiss={() => setToast(null)} />}
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
        <label>เพิ่มโดย (Added by)
          <select value={filter.added_by} onChange={(e) => update({ added_by: e.target.value })}>
            <option value="">ทั้งหมด (All)</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
            <option value="system">ระบบ (sync)</option>
          </select>
        </label>
        <button type="submit" className="btn" style={{ marginBottom: 8 }}>ค้นหา (Search)</button>
      </form>
    </section>
    <section className="panel" style={{ marginTop: 16 }} aria-label="เพิ่มอีเมลที่บล็อก (Add suppression)">
      <form onSubmit={add} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label>อีเมล (Email)
          <input type="email" value={addEmail} maxLength={254} autoComplete="off" placeholder="name@example.com" onChange={(e) => setAddEmail(e.target.value)} />
        </label>
        <label>เหตุผลสำหรับอีเมลใหม่ (Reason for the new entry)
          <select value={addReason} onChange={(e) => setAddReason(e.target.value as SuppressionReason)}>
            {SuppressionReason.options.map((value) => <option key={value} value={value}>{reasons[value][0]}</option>)}
          </select>
        </label>
        <button type="submit" className="btn pri" style={{ marginBottom: 8 }}>เพิ่มอีเมล (Add)</button>
      </form>
    </section>
    <section className="panel" style={{ marginTop: 16 }} aria-label="รายการอีเมลที่บล็อก (Suppression list)">
      {error ? <p role="alert">{error}</p> : !page ? <Spinner /> : <>
        <DataTable label="รายการอีเมลที่บล็อก (Suppression list)" columns={columns} rows={page.rows} rowKey={(r) => r.email} empty={empty} />
        {page.next_cursor && <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={() => setCursor(page.next_cursor)}>ถัดไป (Next)</button></div>}
      </>}
    </section>
    {confirmDialog}
  </>;
}
