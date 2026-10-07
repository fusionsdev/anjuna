import type { FunnelReportResponse } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";

const day = (iso: string) => iso.slice(0, 10);

function shiftDay(dayText: string, days: number): string {
  const date = new Date(`${dayText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function FunnelScreen() {
  const today = new Date().toISOString().slice(0, 10);
  const [fromDay, setFromDay] = useState(shiftDay(today, -7));
  const [toDay, setToDay] = useState(today);
  const [report, setReport] = useState<FunnelReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport(await api.funnel({ from: `${fromDay}T00:00:00.000Z`, to: `${shiftDay(toDay, 1)}T00:00:00.000Z` }));
    } catch (e) {
      setReport(null);
      setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ");
    }
  }, [fromDay, toDay]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1>รายงานฟันเนล (Funnel)</h1>
      <form
        className="form-inline"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label>
          จาก
          <input type="date" value={fromDay} onChange={(event) => setFromDay(event.target.value)} />
        </label>
        <label>
          ถึง
          <input type="date" value={toDay} onChange={(event) => setToDay(event.target.value)} />
        </label>
        <button className="primary" type="submit">ดูรายงาน</button>
      </form>
      {error ? (
        <div className="error">{error}</div>
      ) : !report ? (
        <div className="muted">กำลังโหลด…</div>
      ) : (
        <>
          <p className="muted small">{day(report.from)} – {day(report.to)} (ไม่รวมวันสิ้นสุด)</p>
          <table className="table">
            <thead>
              <tr>
                <th>แบรนด์</th>
                <th>คีย์เวิร์ด</th>
                <th>ตัวแปร</th>
                <th>คลิก</th>
                <th>/go</th>
                <th>เปิดฟอร์ม</th>
                <th>ส่ง</th>
                <th>ขายได้</th>
                <th>รายได้</th>
                <th>อัตราส่ง</th>
                <th>อัตราขาย</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={`${row.brand}:${row.keyword ?? ""}:${row.variant ?? ""}`}>
                  <td>{row.brand}</td>
                  <td>{row.keyword ?? "—"}</td>
                  <td>{row.variant ?? "—"}</td>
                  <td className="num">{row.clicks}</td>
                  <td className="num">{row.go_count}</td>
                  <td className="num">{row.form_views}</td>
                  <td className="num">{row.submits}</td>
                  <td className="num">{row.sold}</td>
                  <td className="num">{row.revenue.toFixed(2)}</td>
                  <td className="num">{rate(row.submit_rate)}</td>
                  <td className="num">{rate(row.sold_rate)}</td>
                </tr>
              ))}
              {report.rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="muted">ไม่มีข้อมูลในช่วงนี้</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
