import type { AdminRole } from "@anjuna/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me, type PanelUser } from "../api";
import { useConfirm } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { UserSessionsDrawer } from "./UserSessions";

// spec polish D1.2, D1.6: status badges, per-row admin actions, client-side search.
export function UsersScreen({ me }: { me: Me }) {
  const [users, setUsers] = useState<PanelUser[] | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "employee" as AdminRole });
  const [confirm, confirmDialog] = useConfirm();
  const [sessionsUser, setSessionsUser] = useState<PanelUser | null>(null);
  const [resetTarget, setResetTarget] = useState<PanelUser | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [resetErr, setResetErr] = useState<string | null>(null);
  // The Ban reason lives in a ref, not state: the confirm body is frozen at confirm() time,
  // so a controlled input would never update. An uncontrolled input writes here on change.
  const banReason = useRef("");

  const load = useCallback(() => api.users().then(setUsers, (e) => setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ" })), []);
  useEffect(() => void load(), [load]);

  async function act(fn: () => Promise<unknown>, okText: string) {
    setToast(null);
    try {
      await fn();
      setToast({ kind: "ok", text: okText });
      await load();
    } catch (e) {
      setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "ไม่สำเร็จ" });
    }
  }

  async function ban(u: PanelUser) {
    banReason.current = "";
    const ok = await confirm({
      title: `ระงับ ${u.email} (Ban ${u.email})?`,
      body: (
        <>
          <p>ผู้ใช้นี้จะเข้าสู่ระบบไม่ได้ และเซสชันปัจจุบันจะใช้ไม่ได้ (This user will not be able to sign in)</p>
          <label>เหตุผล (Reason, ไม่บังคับ)<input aria-label="เหตุผล (Reason)" defaultValue="" maxLength={200} placeholder="เหตุผล (Reason, optional)" onChange={(e) => { banReason.current = e.target.value; }} /></label>
        </>
      ),
      confirmLabel: "ระงับ (Ban)",
    });
    if (!ok) return;
    const reason = banReason.current.trim() || undefined;
    await act(() => api.banUser(u.id, reason), `ระงับ ${u.email} แล้ว (Banned ${u.email})`);
  }

  async function unban(u: PanelUser) {
    const ok = await confirm({
      title: `ยกเลิกการระงับ ${u.email} (Unban ${u.email})?`,
      body: "ผู้ใช้นี้จะเข้าสู่ระบบได้อีก (This user will be able to sign in again)",
      confirmLabel: "ยกเลิกการระงับ (Unban)",
    });
    if (!ok) return;
    await act(() => api.unbanUser(u.id), `ยกเลิกการระงับ ${u.email} แล้ว (Unbanned ${u.email})`);
  }

  async function remove(u: PanelUser) {
    const ok = await confirm({
      title: `ลบ ${u.email} (Delete ${u.email})?`,
      body: `ลบ ${u.email} และเซสชันทั้งหมดของผู้ใช้นี้ถาวร (Permanently delete ${u.email} and all of their sessions)`,
      confirmLabel: "ลบ (Delete)",
      tone: "danger",
    });
    if (!ok) return;
    await act(() => api.deleteUser(u.id), `ลบ ${u.email} แล้ว (Deleted ${u.email})`);
  }

  function openReset(u: PanelUser) {
    setResetTarget(u);
    setResetPw("");
    setResetErr(null);
  }

  async function submitReset() {
    if (!resetTarget) return;
    if (resetPw.length < 8 || resetPw.length > 128) {
      setResetErr("รหัสผ่านต้องมี 8 ถึง 128 ตัว (Password must be 8 to 128 characters)");
      return;
    }
    const target = resetTarget;
    const pw = resetPw;
    setResetTarget(null);
    const ok = await confirm({
      title: `รีเซ็ตรหัสผ่านของ ${target.email} (Reset the password of ${target.email})?`,
      body: "รหัสผ่านใหม่มีผลทันที และเซสชันทั้งหมดของผู้ใช้นี้จะถูกเพิกถอน (The new password takes effect immediately and all sessions are revoked)",
      confirmLabel: "รีเซ็ตรหัสผ่าน (Reset password)",
      tone: "danger",
    });
    if (!ok) return;
    await act(() => api.resetUserPassword(target.id, pw), `รีเซ็ตรหัสผ่านของ ${target.email} แล้ว (Reset the password of ${target.email})`);
  }

  const needle = q.trim().toLowerCase();
  const rows = (users ?? []).filter((u) => !needle || u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle));

  const columns: Column<PanelUser>[] = [
    { key: "name", header: "ชื่อ", cell: (u) => u.name },
    { key: "email", header: "อีเมล", cell: (u) => u.email },
    {
      key: "role", header: "สิทธิ์", cell: (u) => (
        <select
          aria-label={`สิทธิ์ของ ${u.email}`}
          value={u.role}
          disabled={u.id === me.id}
          onChange={async (e) => {
            const next = e.target.value as AdminRole;
            const ok = await confirm({
              title: `เปลี่ยนสิทธิ์ของ ${u.email} เป็น ${next === "owner" ? "Owner" : "พนักงาน"}?`,
              confirmLabel: "เปลี่ยนสิทธิ์ (Change role)",
              tone: next === "owner" ? "danger" : "default",
            });
            if (!ok) return;
            await act(() => api.setRole(u.id, next), `เปลี่ยนสิทธิ์ของ ${u.email} แล้ว`);
          }}
        >
          <option value="employee">พนักงาน</option>
          <option value="owner">Owner</option>
        </select>
      ),
    },
    {
      key: "status", header: "สถานะ (Status)", cell: (u) => (
        u.banned ? <StatusBadge tone="bad" label="ถูกระงับ (Banned)" /> : <StatusBadge tone="live" label="ใช้งาน (Active)" />
      ),
    },
    {
      key: "actions", header: "การจัดการ (Actions)", cell: (u) => (
        u.id === me.id ? null : (
          <div className="row">
            {u.banned
              ? <button className="btn" onClick={() => unban(u)}>ยกเลิกการระงับ (Unban)</button>
              : <button className="btn warn" onClick={() => ban(u)}>ระงับ (Ban)</button>}
            <button className="btn" onClick={() => openReset(u)}>รีเซ็ตรหัสผ่าน (Reset password)</button>
            <button className="btn" onClick={() => setSessionsUser(u)}>เซสชัน (Sessions)</button>
            <button className="btn danger" onClick={() => remove(u)}>ลบ (Delete)</button>
          </div>
        )
      ),
    },
  ];

  const empty = needle
    ? <EmptyState title="ไม่พบผู้ใช้ที่ตรงกับคำค้น (No users match this search)" hint="ลองเปลี่ยนคำค้น (Try another search)" />
    : <EmptyState title="ยังไม่มีผู้ใช้ (No users yet)" />;

  return (
    <>
      <h1 aria-label="ผู้ใช้ (Users)">ผู้ใช้</h1>
      <p className="hint">Owner ตั้งค่าเงินและอนุมัติเทมเพลตได้ พนักงานสร้างและแก้แบรนด์ได้</p>
      {toast && <Toast kind={toast.kind} text={toast.text} onDismiss={() => setToast(null)} />}
      <section className="panel" style={{ marginTop: 16 }}>
        <label>ค้นหา (Search)<input type="search" aria-label="ค้นหาผู้ใช้ (Search users)" placeholder="ชื่อหรืออีเมล (Name or email)" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </section>
      <section className="panel" style={{ marginTop: 16 }}>
        {users === null
          ? <Spinner />
          : <DataTable label="ผู้ใช้ (Users)" columns={columns} rows={rows} rowKey={(u) => u.id} empty={empty} />}
      </section>
      <form
        className="panel"
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12, marginTop: 16, alignItems: "end" }}
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api.createUser(form);
            setForm({ email: "", name: "", password: "", role: "employee" });
          }, "เพิ่มผู้ใช้แล้ว");
        }}
      >
        <h2 style={{ gridColumn: "1 / -1" }}>เพิ่มผู้ใช้</h2>
        <label>อีเมล<input placeholder="อีเมล" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>ชื่อ<input placeholder="ชื่อ" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>รหัสผ่านเริ่มต้น (อย่างน้อย 8 ตัว)<input placeholder="รหัสผ่านเริ่มต้น (≥ 8)" type="password" minLength={8} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <label>สิทธิ์<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AdminRole })}>
          <option value="employee">พนักงาน</option>
          <option value="owner">Owner</option>
        </select></label>
        <button className="btn pri" style={{ justifySelf: "start" }}>เพิ่มผู้ใช้</button>
      </form>
      {resetTarget && (
        <div className="modal-wrap">
          <div className="card modal" role="dialog" aria-modal="true" aria-label="รีเซ็ตรหัสผ่าน (Reset password)">
            <h2>รีเซ็ตรหัสผ่านของ {resetTarget.email} (Reset password)</h2>
            <label>รหัสผ่านใหม่ (New password, 8 ถึง 128 ตัว)<input type="password" aria-label="รหัสผ่านใหม่ (New password)" minLength={8} maxLength={128} value={resetPw} onChange={(e) => setResetPw(e.target.value)} /></label>
            {resetErr && <div className="error">{resetErr}</div>}
            <div className="confirm-actions">
              <button type="button" className="btn" onClick={() => setResetTarget(null)}>ยกเลิก (Cancel)</button>
              <button type="button" className="btn pri" onClick={() => submitReset()}>บันทึก (Save)</button>
            </div>
          </div>
        </div>
      )}
      {sessionsUser && <UserSessionsDrawer user={sessionsUser} onClose={() => setSessionsUser(null)} />}
      {confirmDialog}
    </>
  );
}
