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
      <h1>สถานะเมล (Mailing)</h1>
      {error ? (
        <div className="error">{error}</div>
      ) : !status ? (
        <div className="muted">กำลังโหลด…</div>
      ) : (
        <>
          <p className={status.external_sync === "configured" ? "ok" : "warn"}>
            {status.external_sync === "configured"
              ? "ตั้งค่า LISTMONK แล้ว หน้านี้แสดงจำนวนใน mailing_outbox และไม่ได้เรียก listmonk"
              : "ยังไม่ได้ตั้งค่า LISTMONK แสดงจำนวนใน mailing_outbox และไม่ได้เรียก listmonk"}
          </p>
          <div className="stat-grid">
            <section className="section"><h3>รอส่ง</h3><p className="num">{status.counts.pending}</p></section>
            <section className="section"><h3>ส่งแล้ว</h3><p className="num">{status.counts.sent}</p></section>
            <section className="section"><h3>ข้าม</h3><p className="num">{status.counts.skipped}</p></section>
            <section className="section"><h3>หยุดส่ง</h3><p className="num">{status.counts.dead}</p></section>
          </div>
        </>
      )}
    </>
  );
}
