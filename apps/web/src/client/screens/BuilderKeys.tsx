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
      <h1 aria-label="คีย์ Builder (Builder keys)">คีย์ Builder</h1>
      <p className="hint">ให้ bolt.new ส่งเทมเพลตเข้ามาตรวจได้เอง · หนึ่งคนต่อหนึ่งคีย์ · คีย์แสดงในตารางตลอด</p>
      {msg && <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>{msg}</div>}
      <section className="panel" style={{ marginTop: 16 }}><div className="tw"><table>
        <thead>
          <tr><th>ชื่อ</th><th>คีย์</th><th>สร้างเมื่อ</th><th>ใช้ล่าสุด</th><th>สถานะ</th><th /></tr>
        </thead>
        <tbody>
          {(keys ?? []).map((k) => (
            <tr key={k.key_id}>
              <td>{k.label}</td>
              <td>
                {k.secret ? (
                  <>
                    <code style={{ display: "inline-block", maxWidth: "min(100%, 30ch)", overflowWrap: "anywhere", padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)", fontSize: 12 }}>{k.secret}</code>{" "}
                    <button className="btn" aria-label={`คัดลอกคีย์ ${k.label} (Copy)`} onClick={() => void copy(k)}>
                      {copiedId === k.key_id ? "คัดลอกแล้ว (Copied)" : "คัดลอก (Copy)"}
                    </button>
                  </>
                ) : (
                  <span className="hint">ไม่ได้เก็บไว้ สร้างคีย์ใหม่ (Not stored, create a new key)</span>
                )}
              </td>
              <td className="hint">{k.created_at}</td>
              <td className="hint">{k.last_used_at ?? "ยังไม่เคยใช้ (Never)"}</td>
              <td><span className={`pill ${k.revoked_at ? "p-mute" : "p-live"}`}>{k.revoked_at ? "ยกเลิกแล้ว (Revoked)" : "ใช้งาน (Active)"}</span></td>
              <td>
                {me.role === "owner" && !k.revoked_at && (
                  <button
                    className="btn neg"
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
      </table></div></section>
      <div className="panel" style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 12, marginTop: 16 }}>
        <h2 style={{ flexBasis: "100%" }}>สร้างคีย์ใหม่</h2>
        <label style={{ flex: "1 1 220px" }}>ชื่อคีย์<input aria-label="ชื่อคีย์ (Key label)" placeholder="เช่น Somchai (bolt.new)" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <button
          className="btn pri"
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
