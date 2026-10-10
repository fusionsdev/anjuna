import type { LatestUpgradeResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api } from "../api";

// Same cap as the single-install poll in BrandLifecycle: 120 polls x 3s = 6 minutes.
export const MAX_UPGRADE_POLLS = 120;

const outcomeLabel: Record<string, string> = {
  queued: "รอคิว (queued)", running: "กำลังทำงาน (running)", ready: "พร้อมใช้งาน (ready)", failed: "ล้มเหลว (failed)",
  rolled_back: "ย้อนกลับแล้ว (rolled-back)", skipped: "ข้าม (skipped)",
};

export function UpgradeOutcomes({ refresh }: { refresh: number }) {
  const [result, setResult] = useState<LatestUpgradeResponse>();
  const [error, setError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    setStalled(false);
    async function load() {
      try {
        const next = await api.latestUpgrade();
        if (!active) return;
        setResult(next);
        setError(null);
        if (!next.upgrade?.outcomes.some((row) => row.status === "queued" || row.status === "running")) return;
        if (polls >= MAX_UPGRADE_POLLS) { setStalled(true); return; }
        polls += 1;
        timer = setTimeout(() => void load(), 3000);
      } catch {
        if (active) setError("โหลดผลอัปเกรดทุกแบรนด์ไม่ได้ (Could not load upgrade-all outcomes) กรุณารีเฟรชเพื่อลองใหม่");
      }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);

  return <section className="card upgrade-outcomes" aria-label="ผลอัปเกรดทุกแบรนด์ล่าสุด (Latest upgrade-all outcomes)">
    <h2>ผลอัปเกรดทุกแบรนด์ล่าสุด (Latest upgrade-all outcomes)</h2>
    {error && <p className="error" role="alert">{error}{result?.upgrade && " แสดงผลที่โหลดไว้ก่อนหน้า (Showing previously loaded outcomes)"}</p>}
    {stalled && <p className="error" role="alert">หยุดรีเฟรชอัตโนมัติหลัง 6 นาที (Auto-refresh stopped): บางแบรนด์ยังรอคิวหรือกำลังทำงาน การติดตั้งอาจค้าง กรุณารีเฟรชเพื่อตรวจอีกครั้ง</p>}
    {!result && !error && <p role="status">กำลังโหลดผลอัปเกรด (Loading upgrade-all outcomes)…</p>}
    {result?.command_error && <p className="error" role="alert">คำสั่งอัปเกรดล่าสุดอ่านไม่ได้ (Latest upgrade command is unreadable): audit #{result.command_error.audit_id}</p>}
    {result?.upgrade === null && !result.command_error && <p>ยังไม่มีการอัปเกรดทุกแบรนด์ที่รับคำสั่ง (No accepted upgrade-all yet)</p>}
    {result?.upgrade && <>
      <p><code>{result.upgrade.command.from_template_version_id}</code> → <code>{result.upgrade.command.to_template_version_id}</code> · รับคำสั่งเมื่อ (Accepted) {result.upgrade.accepted_at}</p>
      <table className="table">
        <thead><tr><th>แบรนด์ (Brand)</th><th>บทบาท (Role)</th><th>ผลลัพธ์ (Outcome)</th><th>ติดตั้ง (Install)</th><th>รายละเอียด (Details)</th></tr></thead>
        <tbody>{result.upgrade.outcomes.map((row) => <tr key={row.brand_id}>
          <th scope="row">{row.domain}<br /><code>{row.brand_id}</code></th>
          <td>{row.is_canary ? "ทดลองก่อน (Canary)" : "—"}</td>
          <td>{outcomeLabel[row.status] ?? row.status}</td>
          <td>{row.install_id ? <code>{row.install_id}</code> : "—"}{row.retry_of && <><br />ลองใหม่จาก (Retry of) <code>{row.retry_of}</code></>}</td>
          <td>{row.error ?? "—"}</td>
        </tr>)}</tbody>
      </table>
    </>}
  </section>;
}
