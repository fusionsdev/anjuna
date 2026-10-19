import type { BuilderKeySummary } from "@anjuna/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";

export function BuilderKeysScreen({ me }: { me: Me }) {
  const [keys, setKeys] = useState<BuilderKeySummary[] | null>(null);
  const [label, setLabel] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);

  const load = useCallback(() => api.builderKeys().then((r) => setKeys(r.keys), (e) => setMsg(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ")), []);
  useEffect(() => void load(), [load]);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  async function run(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.thai : "ไม่สำเร็จ");
    }
  }

  async function copy(k: BuilderKeySummary) {
    if (!k.secret) return;
    setMsg(null);
    try {
      await navigator.clipboard.writeText(k.secret);
    } catch {
      setMsg("คัดลอกไม่สำเร็จ (Copy failed)");
      return;
    }
    setCopiedId(k.key_id);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedId((id) => (id === k.key_id ? null : id)), 2000);
  }

  return (
    <>
      <h1>คีย์ Builder (Builder keys)</h1>
      <p className="muted">คีย์สำหรับเชื่อม bolt.new กับ template MCP หนึ่งคนต่อหนึ่งคีย์ คีย์แสดงในตารางตลอด (One key per staff member; the key stays visible here)</p>
      {msg && <div className="error">{msg}</div>}
      <table className="table">
        <thead>
          <tr><th>ชื่อคีย์ (Label)</th><th>คีย์ (Key)</th><th>สร้างเมื่อ (Created)</th><th>ใช้ล่าสุด (Last used)</th><th>สถานะ (Status)</th><th /></tr>
        </thead>
        <tbody>
          {(keys ?? []).map((k) => (
            <tr key={k.key_id}>
              <td>{k.label}</td>
              <td>
                {k.secret ? (
                  <>
                    <code>{k.secret}</code>{" "}
                    <button aria-label={`คัดลอกคีย์ ${k.label} (Copy)`} onClick={() => void copy(k)}>
                      {copiedId === k.key_id ? "คัดลอกแล้ว (Copied)" : "คัดลอก (Copy)"}
                    </button>
                  </>
                ) : (
                  <span className="muted small">ไม่ได้เก็บไว้ สร้างคีย์ใหม่ (Not stored, create a new key)</span>
                )}
              </td>
              <td className="muted small">{k.created_at}</td>
              <td className="muted small">{k.last_used_at ?? "ยังไม่เคยใช้ (Never)"}</td>
              <td><span className={`pill ${k.revoked_at ? "alert" : "ok"}`}>{k.revoked_at ? "ยกเลิกแล้ว (Revoked)" : "ใช้งาน (Active)"}</span></td>
              <td>
                {me.role === "owner" && !k.revoked_at && (
                  <button
                    className="danger"
                    aria-label={`ยกเลิกคีย์ ${k.label} (Revoke)`}
                    onClick={() => { if (window.confirm(`ยกเลิกคีย์ ${k.label}? bolt.new ที่ใช้คีย์นี้จะเชื่อมต่อไม่ได้ทันที`)) void run(() => api.revokeBuilderKey(k.key_id)); }}
                  >
                    ยกเลิก (Revoke)
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card form-inline">
        <h2>สร้างคีย์ใหม่ (New key)</h2>
        <input aria-label="ชื่อคีย์ (Key label)" placeholder="เช่น Somchai (bolt.new)" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        <button
          className="primary"
          disabled={!label.trim()}
          onClick={() => void run(async () => {
            await api.createBuilderKey(label.trim());
            setLabel("");
          })}
        >
          สร้างคีย์ (Create key)
        </button>
      </div>
    </>
  );
}
