import type { LeadConversion, LeadDetail } from "@anjuna/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { BrandLabel } from "../brand-labels";
import { type Column, DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { NotFound } from "./NotFound";

// spec leads
type Postback = LeadDetail["postbacks"][number] & { index?: number };

const OUTCOME: Record<LeadDetail["outcome"], { label: string; tone: Tone }> = {
  sold: { label: "ขายได้ (Sold)", tone: "live" },
  pending: { label: "รอผล (Pending)", tone: "blue" },
  rejected: { label: "ถูกปฏิเสธ (Rejected)", tone: "bad" },
};
const UPLOAD: Record<LeadConversion["status"], { label: string; tone: Tone }> = {
  pending: { label: "รออัปโหลด (Pending)", tone: "blue" },
  processing: { label: "กำลังอัปโหลด (Processing)", tone: "blue" },
  uploaded: { label: "อัปโหลดแล้ว (Uploaded)", tone: "live" },
  dead: { label: "ล้มเหลวถาวร (Dead)", tone: "bad" },
};
const CLICK_TYPE: Record<LeadConversion["click_type"], string> = {
  gclid: "gclid", gbraid: "gbraid", wbraid: "wbraid", msclkid: "msclkid", none: "ไม่มี (None)",
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("th-TH", { hour12: false }) : "");
const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const yesNo = (v: boolean) => (v ? "ใช่ (Yes)" : "ไม่ใช่ (No)");
const message = (e: unknown) => (e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ");

/** First matching rule wins; null when none applies (an upload still in flight is not a finding). */
function reconcile(postbacks: Postback[], conversion: LeadConversion | null): { text: string; tone: Tone } | null {
  if (postbacks.some((p) => p.event_type === "soldLead") && !conversion) return { text: "ขายแล้วแต่ไม่มีรายการอัปโหลด", tone: "bad" };
  if (conversion?.status === "dead") return { text: "อัปโหลดล้มเหลวถาวร", tone: "bad" };
  if (conversion?.status === "uploaded") return { text: "ส่งคอนเวอร์ชันแล้ว", tone: "live" };
  if (postbacks.length === 0) return { text: "ยังไม่มี postback จาก LeadsGate", tone: "warn" };
  return null;
}

function Fields({ label, rows }: { label: string; rows: Array<[string, ReactNode]> }) {
  return (
    <div className="tw">
      <table aria-label={label}>
        <tbody>
          {rows.map(([name, value]) => (
            <tr key={name}>
              <th scope="row" style={{ textAlign: "left", paddingLeft: 0 }}>{name}</th>
              <td style={{ textAlign: "left" }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Applicant({ applicant }: { applicant: NonNullable<LeadDetail["applicant"]> }) {
  return <Fields label="ผู้สมัคร (Applicant)" rows={[
    ["ชื่อ (First name)", applicant.first_name],
    ["นามสกุล (Last name)", applicant.last_name],
    ["วันเกิด (Birth date)", applicant.birth_date],
    ["อีเมล (Email)", applicant.email],
    ["เบอร์บ้าน (Home phone)", applicant.home_phone],
    ["เบอร์ที่ทำงาน (Work phone)", applicant.work_phone],
    ["ที่อยู่ (Address)", applicant.address],
    ["เมือง (City)", applicant.city],
    ["รหัสไปรษณีย์ (ZIP)", applicant.zip],
  ]} />;
}

function Conversion({ conversion, owner }: { conversion: LeadConversion; owner: boolean }) {
  const upload = UPLOAD[conversion.status];
  const rows: Array<[string, ReactNode]> = [
    ["สถานะ (Status)", <StatusBadge tone={upload.tone} label={upload.label} />],
    ["ประเภท click id (Click type)", CLICK_TYPE[conversion.click_type]],
    ["จำนวนครั้งที่ลอง (Attempts)", conversion.attempts],
    ["ลองครั้งถัดไป (Next attempt)", fmt(conversion.next_attempt_at)],
    ["สกุลเงิน (Currency)", conversion.currency],
  ];
  if (owner) rows.push(["มูลค่า (Value)", conversion.value === null ? "" : money(conversion.value)]);
  if (conversion.last_error !== null) {
    rows.push(["ข้อผิดพลาดล่าสุด (Last error)", (
      <details>
        <summary>ดูข้อความ (Show)</summary>
        <pre className="hint" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{conversion.last_error}</pre>
      </details>
    )]);
  }
  return <Fields label="Conversion" rows={rows} />;
}

export function LeadDetailScreen({ me, leadId, onBack }: { me: Me; leadId: string; onBack: () => void }) {
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setLead(null); setMissing(false); setError(null);
    api.lead(leadId).then(
      (next) => { if (active) setLead(next); },
      (e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(message(e));
      },
    );
    return () => { active = false; };
  }, [leadId]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(leadId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (missing) return <NotFound title="ไม่พบลีดนี้ (Lead not found)" hint={leadId} />;

  const back = <button type="button" className="btn" onClick={onBack}>← กลับรายการลีด (Back to leads)</button>;
  if (error) return <><p role="alert">{error}</p>{back}</>;
  if (!lead) return <Spinner />;

  const outcome = OUTCOME[lead.outcome];
  const showPayout = me.role === "owner";
  const found = reconcile(lead.postbacks, lead.conversion);
  const postbackColumns: Column<Postback>[] = [
    { key: "event", header: "เหตุการณ์ (Event)", cell: (p) => p.event_type },
    ...(showPayout ? [{ key: "payout", header: "ค่าตอบแทน (Payout)", align: "right" as const, cell: (p: Postback) => (p.payout === null ? "" : money(p.payout)) }] : []),
    { key: "received", header: "รับเมื่อ (Received)", cell: (p) => fmt(p.created_at) },
  ];

  return <>
    <div className="head" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <div>
        <h1>รายละเอียดลีด (Lead detail)</h1>
        <p className="sub" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <BrandLabel brandId={lead.brand_id} domain={lead.hostname} />
          <StatusBadge tone={outcome.tone} label={outcome.label} />
          <code>{lead.lead_id}</code>
          <button type="button" className="btn" onClick={() => { void copy(); }}>{copied ? "คัดลอกแล้ว (Copied)" : "คัดลอก (Copy)"}</button>
        </p>
      </div>
      {back}
    </div>

    <section className="panel" aria-label="ลีด (Lead)">
      <Fields label="ลีด (Lead)" rows={[
        ["สร้างเมื่อ (Created)", fmt(lead.created_at)],
        ["อัปเดตเมื่อ (Updated)", fmt(lead.updated_at)],
        ["สถานะดิบ (Raw status)", lead.status],
        ["ยอดที่ขอ (Amount)", money(lead.requested_amount)],
        ["วัตถุประสงค์ (Purpose)", lead.loan_purpose],
        ["คีย์เวิร์ด (Keyword)", lead.keyword],
        ["ตัวแปร (Variant)", lead.variant],
        ["การทดลอง (Experiment)", lead.experiment_id],
        ["ฟอร์ม (Form)", `${lead.form_version} / ${lead.form_variant}`],
      ]} />
    </section>

    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="lead-applicant">
      <h2 id="lead-applicant">ผู้สมัคร (Applicant)</h2>
      {lead.applicant ? <Applicant applicant={lead.applicant} /> : <p className="hint">ข้อมูลส่วนบุคคลสงวนสำหรับ Owner (Personal data is owner-only)</p>}
    </section>

    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="lead-profile">
      <h2 id="lead-profile">คุณสมบัติ (Profile)</h2>
      <Fields label="คุณสมบัติ (Profile)" rows={[
        ["รัฐ (State)", lead.profile.state],
        ["อยู่ที่อยู่เดิม (เดือน) (Months at address)", lead.profile.address_length_months],
        ["เจ้าของบ้าน (Own home)", yesNo(lead.profile.own_home)],
        ["ประเภทรายได้ (Income type)", lead.profile.income_type],
        ["นายจ้าง (Employer)", lead.profile.employer],
        ["ตำแหน่ง (Job title)", lead.profile.job_title],
        ["อายุงาน (เดือน) (Months employed)", lead.profile.employed_months],
        ["วันจ่ายเงินเดือน (Pay date)", lead.profile.pay_date1],
        ["ความถี่ (Pay frequency)", lead.profile.pay_frequency],
        ["ฝากตรง (Direct deposit)", yesNo(lead.profile.direct_deposit)],
        ["รายได้ต่อเดือน (Monthly income)", money(lead.profile.monthly_income)],
      ]} />
    </section>

    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="lead-inspector">
      <h2 id="lead-inspector">Postback Inspector</h2>
      {found && <p role="status" aria-label="ตรวจยอด (Reconciliation)"><StatusBadge tone={found.tone} label={found.text} /></p>}
      <DataTable label="Postback" columns={postbackColumns} rows={lead.postbacks.map((p, index) => ({ ...p, index }))} rowKey={(p) => `${p.event_type}|${p.created_at}|${p.index}`}
        empty={<EmptyState title="ยังไม่มี postback (No postbacks yet)" />} />
      <h3 style={{ marginTop: 16 }}>Conversion</h3>
      {lead.conversion ? <Conversion conversion={lead.conversion} owner={showPayout} /> : <p className="hint">ไม่มีรายการอัปโหลด (No conversion upload)</p>}
    </section>
  </>;
}
