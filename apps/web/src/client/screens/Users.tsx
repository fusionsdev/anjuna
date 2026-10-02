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
      <h1>ผู้ใช้ (Users)</h1>
      {msg && <div className="error">{msg}</div>}
      <table className="table">
        <thead>
          <tr>
            <th>ชื่อ</th>
            <th>อีเมล</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {(users ?? []).map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                <select
                  value={u.role}
                  disabled={u.id === me.id}
                  onChange={(e) => run(() => api.setRole(u.id, e.target.value as AdminRole))}
                >
                  <option value="employee">employee</option>
                  <option value="owner">owner</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="card form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.createUser(form);
            setForm({ email: "", name: "", password: "", role: "employee" });
          });
        }}
      >
        <h2>เพิ่มผู้ใช้</h2>
        <input placeholder="อีเมล" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input placeholder="ชื่อ" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="รหัสผ่านเริ่มต้น (≥ 8)" type="password" minLength={8} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AdminRole })}>
          <option value="employee">employee</option>
          <option value="owner">owner</option>
        </select>
        <button className="primary">เพิ่ม</button>
      </form>
    </>
  );
}
