import type { BuilderKeySummary } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";

export function BuilderKeysScreen() {
  const [keys, setKeys] = useState<BuilderKeySummary[] | null>(null);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<{ label: string; secret: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => api.builderKeys().then((r) => setKeys(r.keys), (e) => setMsg(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ")), []);
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
      <h1>คีย์ Builder (Builder keys)</h1>
      <p className="muted">คีย์สำหรับเชื่อม bolt.new กับ template MCP หนึ่งคนต่อหนึ่งคีย์ (One key per staff member for the bolt.new connector)</p>
      {msg && <div className="error">{msg}</div>}
      <table className="table">
        <thead>
          <tr><th>ชื่อคีย์ (Label)</th><th>สร้างเมื่อ (Created)</th><th>ใช้ล่าสุด (Last used)</th><th>สถานะ (Status)</th><th /></tr>
        </thead>
        <tbody>
          {(keys ?? []).map((k) => (
            <tr key={k.key_id}>
              <td>{k.label}</td>
              <td className="muted small">{k.created_at}</td>
              <td className="muted small">{k.last_used_at ?? "ยังไม่เคยใช้ (Never)"}</td>
              <td><span className={`pill ${k.revoked_at ? "alert" : "ok"}`}>{k.revoked_at ? "ยกเลิกแล้ว (Revoked)" : "ใช้งาน (Active)"}</span></td>
              <td>
                {!k.revoked_at && (
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
            const r = await api.createBuilderKey(label.trim());
            setCreated({ label: r.key.label, secret: r.secret });
            setLabel("");
          })}
        >
          สร้างคีย์ (Create key)
        </button>
      </div>
      {created && <SecretModal label={created.label} secret={created.secret} onClose={() => setCreated(null)} />}
    </>
  );
}

function SecretModal({ label, secret, onClose }: { label: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-wrap" role="dialog" aria-modal="true" aria-label="คีย์ใหม่ (New key)">
      <div className="card modal">
        <h2>{`คีย์ใหม่: ${label} (New key)`}</h2>
        <div className="warn">คุณจะไม่เห็นคีย์นี้อีก (you will not see this again). คัดลอกแล้ววางใน bolt.new: Connectors, API key</div>
        <code className="token">{secret}</code>
        <div className="row">
          <button className="primary" onClick={async () => { await navigator.clipboard?.writeText(secret).catch(() => undefined); setCopied(true); }}>
            {copied ? "คัดลอกแล้ว (Copied)" : "คัดลอก (Copy)"}
          </button>
          <button onClick={onClose}>ปิด (Close)</button>
        </div>
      </div>
    </div>
  );
}
