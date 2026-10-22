import { CLICK_RISK_ALERT_AT, type RiskPeriod, type TrafficRiskResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";

const count = (value: number) => value.toLocaleString("en-US");

export interface RiskPanelProps {
  /** Window of the report; Funnel passes its own period selection. */
  period?: RiskPeriod;
  /** Owner only: shows the refund export link. The server refuses the export to an employee anyway. */
  canExport?: boolean;
}

/**
 * "คะแนนความเสี่ยงของคลิก" panel of the console mockup (FUS-372). The score is observe-only:
 * every visitor sees the same page, the panel only reports and exports for a Google refund.
 */
export function RiskPanel({ period = "7d", canExport = false }: RiskPanelProps) {
  const [report, setReport] = useState<TrafficRiskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setReport(null);
    setError(null);
    api.trafficRisk(period).then(
      (next) => { if (live) setReport(next); },
      (e: unknown) => { if (live) setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ"); },
    );
    return () => { live = false; };
  }, [period]);

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-label="คะแนนความเสี่ยงของคลิก">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2>คะแนนความเสี่ยงของคลิก</h2>
        <span className="pill p-mute">โหมดเก็บข้อมูล ไม่บล็อกใคร</span>
      </div>
      <p className="hint" style={{ marginTop: 4 }}>ทุกคนเห็นหน้าเว็บเหมือนกัน ระบบแค่จดคะแนนไว้ใช้วิเคราะห์และขอเงินคืนจาก Google</p>
      {error && <p className="note" role="alert">{error}</p>}
      {!error && !report && <p className="hint">กำลังโหลด…</p>}
      {report && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 10 }}>
          <div>
            <h3>สัญญาณที่เจอ</h3>
            {report.signals.map((signal) => (
              <div className="row" key={signal.id} data-signal={signal.id}>
                <div className="t">{signal.label}<span>น้ำหนัก {signal.weight} คะแนน</span></div>
                <b style={{ fontWeight: 500 }}>{count(signal.count)}</b>
              </div>
            ))}
            <p className="hint" style={{ marginTop: 6 }}>น้ำหนักยังเป็นค่าเริ่มต้น ปรับหลังเก็บข้อมูลครบ 2 ถึง 4 สัปดาห์</p>
          </div>
          <div>
            <h3>สัดส่วนคลิกเสี่ยงสูงต่อโดเมน</h3>
            {report.domains.length === 0 && <p className="hint">ยังไม่มีคนเข้าเว็บในช่วงนี้</p>}
            {report.domains.map((domain) => {
              const share = domain.visits > 0 ? domain.high_risk / domain.visits : 0;
              return (
                <div className="row" key={domain.hostname} data-hostname={domain.hostname}>
                  <div className="t">{domain.hostname}<span>{count(domain.high_risk)} จาก {count(domain.visits)} คน</span></div>
                  <span className={`pill ${share >= CLICK_RISK_ALERT_AT ? "p-warn" : "p-mute"}`}>{Math.round(share * 100)}%</span>
                </div>
              );
            })}
            {canExport && (
              <a className="btn" style={{ marginTop: 10, display: "inline-block" }} href={api.trafficRiskExportUrl(period)} download>
                ส่งออกรายการเพื่อขอเงินคืน
              </a>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
