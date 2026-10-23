import type { AlertsReportResponse } from "@anjuna/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError, api } from "../api";
import { BrandLabel, useBrandLabels } from "../brand-labels";

const LABEL: Record<string, string> = {
  ok: "ปกติ",
  warn: "เตือน",
  alert: "ผิดปกติ",
};

const STATE_STYLE = { ok: "p-live", warn: "p-warn", alert: "p-bad" };
const STATE_COLOR = { ok: "var(--money)", warn: "var(--leak)", alert: "var(--bad)" };

function AlertRow({ state, title, detail, children }: { state: "ok" | "warn" | "alert"; title: string; detail: string; children: ReactNode }) {
  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <span className="dot" aria-hidden="true" style={{ background: STATE_COLOR[state] }} />
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <h3>{title}</h3>
        <p className="hint">{detail}</p>
      </div>
      <span className={`pill ${STATE_STYLE[state]}`}>{LABEL[state]}</span>
      <details style={{ maxWidth: "100%" }}>
        <summary className="btn" aria-label={`ดูรายละเอียด: ${title}`} style={{ cursor: "pointer" }}>ดูรายละเอียด</summary>
        <div className="hint" style={{ marginTop: 8, overflowWrap: "anywhere" }}>{children}</div>
      </details>
    </div>
  );
}

export function AlertsScreen() {
  const [report, setReport] = useState<AlertsReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const labelOf = useBrandLabels();

  useEffect(() => {
    api.alerts().then(setReport, (e) => setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ"));
  }, []);

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <h1 aria-label="การแจ้งเตือน (Alerts)">การแจ้งเตือน</h1>
        <p className="hint">ตรวจสถานะและเรื่องที่ต้องจัดการ</p>
      </div>
      {error ? (
        <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">{error}</div>
      ) : !report ? (
        <div className="hint" role="status">กำลังโหลด…</div>
      ) : (
        <>
          <section className="panel" aria-label="รายการแจ้งเตือน">
            <AlertRow state={report.conversion_stalled.state} title="คอนเวอร์ชันค้าง" detail={`ค้าง ${report.conversion_stalled.detail.stuck_count} รายการ เกิน ${report.conversion_stalled.detail.max_hours} ชม.`}>
              {report.conversion_stalled.detail.oldest_created_at ? `รายการเก่าสุด ${new Date(report.conversion_stalled.detail.oldest_created_at).toLocaleString("th-TH", { hour12: false })}` : "ไม่มีรายการค้าง"}
            </AlertRow>
            <AlertRow state={report.brands_without_postbacks.state} title="แบรนด์ไม่มีโพสต์แบ็ก" detail={`${report.brands_without_postbacks.detail.brands.length} แบรนด์ ใน ${report.brands_without_postbacks.detail.window_hours} ชม.`}>
              {report.brands_without_postbacks.detail.brands.length ? <ul>{report.brands_without_postbacks.detail.brands.map((b) => <li key={b.brand}><BrandLabel brandId={b.brand} domain={labelOf(b.brand)} /> · {b.leads} ลีด</li>)}</ul> : "ไม่มีแบรนด์เกินเกณฑ์"}
            </AlertRow>
            <AlertRow state={report.submit_error_rate.state} title="อัตราส่งฟอร์มผิดพลาด" detail={`${report.submit_error_rate.detail.samples.length} แบรนด์เกินเกณฑ์`}>
              {report.submit_error_rate.detail.samples.length ? <ul>{report.submit_error_rate.detail.samples.map((b) => <li key={b.brand}><BrandLabel brandId={b.brand} domain={labelOf(b.brand)} /> · ผิดพลาด {b.errors} · ส่งฟอร์ม {b.submits} · {(b.rate * 100).toLocaleString("th-TH")}%</li>)}</ul> : "ไม่มีแบรนด์เกินเกณฑ์"}
            </AlertRow>
            <AlertRow state={report.reject_rate.state} title="อัตราปฏิเสธ" detail={`${report.reject_rate.detail.brands.length} แบรนด์เกินเกณฑ์`}>
              {report.reject_rate.detail.brands.length ? <ul>{report.reject_rate.detail.brands.map((b) => <li key={b.brand}><BrandLabel brandId={b.brand} domain={labelOf(b.brand)} /> · ปฏิเสธ {b.rejected} จาก {b.decided} · {(b.rate * 100).toLocaleString("th-TH")}%</li>)}</ul> : "ไม่มีแบรนด์เกินเกณฑ์"}
            </AlertRow>
            <AlertRow state={report.click_risk.state} title="คลิกเสี่ยงสูง" detail={report.click_risk.detail.hostnames.length
              ? report.click_risk.detail.hostnames.map((h) => `${h.hostname}: ${Math.round(h.rate * 100)}% ของคนเข้าเว็บได้คะแนนเสี่ยงสูง`).join(" · ")
              : `ไม่มีโดเมนที่คนเข้าเว็บได้คะแนนเสี่ยงสูงเกิน ${Math.round(report.click_risk.detail.alert_at * 100)}% ใน ${report.click_risk.detail.window_hours} ชม.`}>
              {report.click_risk.detail.hostnames.length ? <ul>{report.click_risk.detail.hostnames.map((h) => <li key={h.hostname}>{h.hostname} · เสี่ยงสูง {h.high_risk} จาก {h.visits} คน</li>)}</ul> : "ไม่มีโดเมนเกินเกณฑ์"}
            </AlertRow>
            <p className="hint">ข้อมูล ณ {new Date(report.generated_at).toLocaleString("th-TH", { hour12: false })}</p>
          </section>
          <section className="panel" style={{ marginTop: 16 }} aria-label="เกณฑ์แจ้งเตือน">
            <h2>เกณฑ์แจ้งเตือน</h2>
            <p className="hint">ค่าปัจจุบัน · อ่านอย่างเดียว</p>
            <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12, marginBottom: 0 }}>
              <div><dt className="k">conversion ค้างส่ง Google เกิน (ชั่วโมง)</dt><dd style={{ margin: 0 }}>{report.conversion_stalled.detail.max_hours}</dd></div>
              <div><dt className="k">แบรนด์ไม่มีโพสต์แบ็กในช่วง (ชั่วโมง)</dt><dd style={{ margin: 0 }}>{report.brands_without_postbacks.detail.window_hours}</dd></div>
              <div><dt className="k">อัตราส่งฟอร์มผิดพลาด (%)</dt><dd style={{ margin: 0 }}>เตือน {(report.submit_error_rate.detail.warn_at * 100).toLocaleString("th-TH")}% · ผิดปกติ {(report.submit_error_rate.detail.alert_at * 100).toLocaleString("th-TH")}%</dd><dd className="hint" style={{ margin: 0 }}>ใน {report.submit_error_rate.detail.window_hours} ชั่วโมง</dd></div>
              <div><dt className="k">อัตรา reject (%)</dt><dd style={{ margin: 0 }}>เตือน {(report.reject_rate.detail.warn_at * 100).toLocaleString("th-TH")}% · ผิดปกติ {(report.reject_rate.detail.alert_at * 100).toLocaleString("th-TH")}%</dd><dd className="hint" style={{ margin: 0 }}>ใน {report.reject_rate.detail.window_hours} ชั่วโมง</dd></div>
            </dl>
          </section>
        </>
      )}
    </>
  );
}
