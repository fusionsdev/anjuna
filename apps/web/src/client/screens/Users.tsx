import type { AdminRole } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me, type PanelUser } from "../api";

export function UsersScreen({ me }: { me: Me }) {
  const [users, setUsers] = useState<PanelUser[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "employee" as AdminRole });

  const load = useCallback(() => api.users().then(setUsers, (e) => setMsg(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ")), []);
  useEffect(() => void load(), [load]);

  async function run(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.thai : "ไม่สำเร็จ");
    }
  }

  return (
    <>
      <h1 aria-label="ผู้ใช้ (Users)">ผู้ใช้</h1>
      <p className="hint">Owner ตั้งค่าเงินและอนุมัติเทมเพลตได้ พนักงานสร้างและแก้แบรนด์ได้</p>
      {msg && <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>{msg}</div>}
      <section className="panel" style={{ marginTop: 16 }}><div className="tw"><table>
        <thead>
          <tr>
            <th>ชื่อ</th>
            <th>อีเมล</th>
            <th>สิทธิ์</th>
          </tr>
        </thead>
        <tbody>
          {(users ?? []).map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                <select
                  aria-label={`สิทธิ์ของ ${u.email}`}
                  value={u.role}
                  disabled={u.id === me.id}
                  onChange={(e) => run(() => api.setRole(u.id, e.target.value as AdminRole))}
                >
                  <option value="employee">พนักงาน</option>
                  <option value="owner">Owner</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div></section>
      <form
        className="panel"
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12, marginTop: 16, alignItems: "end" }}
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.createUser(form);
            setForm({ email: "", name: "", password: "", role: "employee" });
          });
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
    </>
  );
}
