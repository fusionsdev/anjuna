import type { AlertsReportResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";

const LABEL: Record<string, string> = {
  ok: "ปกติ",
  warn: "เตือน",
  alert: "ผิดปกติ",
};

function StatePill({ state }: { state: "ok" | "warn" | "alert" }) {
  return <span className={`pill ${state}`}>{LABEL[state]}</span>;
}

export function AlertsScreen() {
  const [report, setReport] = useState<AlertsReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.alerts().then(setReport, (e) => setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ"));
  }, []);

  return (
    <>
      <h1>การแจ้งเตือน (Alerts)</h1>
      {error ? (
        <div className="error">{error}</div>
      ) : !report ? (
        <div className="muted">กำลังโหลด…</div>
      ) : (
        <div className="stat-grid">
          <section className="section">
            <h3>คอนเวอร์ชันค้าง</h3>
            <StatePill state={report.conversion_stalled.state} />
            <p className="small muted">ค้าง {report.conversion_stalled.detail.stuck_count} รายการ เกิน {report.conversion_stalled.detail.max_hours} ชม.</p>
          </section>
          <section className="section">
            <h3>แบรนด์ไม่มีโพสต์แบ็ก</h3>
            <StatePill state={report.brands_without_postbacks.state} />
            <p className="small muted">{report.brands_without_postbacks.detail.brands.length} แบรนด์ ใน {report.brands_without_postbacks.detail.window_hours} ชม.</p>
          </section>
          <section className="section">
            <h3>อัตราส่งฟอร์มผิดพลาด</h3>
            <StatePill state={report.submit_error_rate.state} />
            <p className="small muted">{report.submit_error_rate.detail.samples.length} แบรนด์เกินเกณฑ์</p>
          </section>
          <section className="section">
            <h3>อัตราปฏิเสธ</h3>
            <StatePill state={report.reject_rate.state} />
            <p className="small muted">{report.reject_rate.detail.brands.length} แบรนด์เกินเกณฑ์</p>
          </section>
        </div>
      )}
    </>
  );
}
