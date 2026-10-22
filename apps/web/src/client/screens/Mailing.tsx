import type { MailingStatusResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";

export function MailingScreen() {
  const [status, setStatus] = useState<MailingStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.mailing().then(setStatus, (e) => setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ"));
  }, []);

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <h1 aria-label="สถานะเมล (Mailing)">รายชื่ออีเมล</h1>
        <p className="hint">ลีดที่ยินยอมรับข่าวสาร · สถานะการส่งเข้า listmonk</p>
      </div>
      {error ? (
        <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">{error}</div>
      ) : !status ? (
        <div className="hint" role="status">กำลังโหลด…</div>
      ) : (
        <>
          <div className="ledger" style={{ marginBottom: 16 }}>
            <section className="cell"><h2 className="k">รอส่งเข้า listmonk</h2><p className="v">{status.counts.pending}</p></section>
            <section className="cell"><h2 className="k">ส่งแล้ว</h2><p className="v pos">{status.counts.sent}</p></section>
            <section className="cell"><h2 className="k">ข้าม</h2><p className="v">{status.counts.skipped}</p></section>
            <section className="cell"><h2 className="k">หยุดส่ง</h2><p className="v neg">{status.counts.dead}</p></section>
          </div>
          <section className="panel">
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <h2>การเชื่อมต่อ listmonk</h2>
              <span className={`pill ${status.external_sync === "configured" ? "p-live" : "p-warn"}`}>{status.external_sync === "configured" ? "ตั้งค่าแล้ว" : "ยังไม่ตั้งค่า"}</span>
            </div>
            <p className="hint">จำนวนจากคิวส่งอีเมลในระบบ ยังไม่ใช่จำนวนสมาชิกใน listmonk</p>
            <p className="hint" style={{ marginTop: 8 }}>เบอร์โทรเก็บเป็นข้อมูลเท่านั้น ระบบไม่ส่ง SMS หรือโทรออก</p>
          </section>
        </>
      )}
    </>
  );
}
