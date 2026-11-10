import type { LeadConversion, LeadDetail } from "@anjuna/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { BrandLabel } from "../brand-labels";
import { type Column, DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { Chip } from "../components/Chip";
import { NotFound } from "./NotFound";
import "./Leads.css";


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

type TimelineTone = "info" | "success" | "danger" | "warning";
/** What happened to the lead, oldest first: the form, each LeadsGate postback and the conversion upload. */
export function leadTimeline(lead: LeadDetail): Array<{ label: string; at: string; tone: TimelineTone }> {
  const events: Array<{ label: string; at: string; tone: TimelineTone }> = [{ label: "ส่งฟอร์ม", at: lead.created_at, tone: "info" }];
  for (const p of lead.postbacks) {
    const type = p.event_type;
    if (type === "soldLead") events.push({ label: "postback ขายได้", at: p.created_at, tone: "success" });
    else if (type === "newLead") events.push({ label: "postback ลีดใหม่", at: p.created_at, tone: "info" });
    else if (/reject/i.test(type)) events.push({ label: "postback ปฏิเสธ", at: p.created_at, tone: "danger" });
    else events.push({ label: `postback ${type}`, at: p.created_at, tone: "info" });
  }
  const c = lead.conversion;
  if (c) {
    events.push({ label: "สร้างรายการอัปโหลด", at: c.created_at, tone: "info" });
    if (c.status === "uploaded" && c.updated_at) events.push({ label: "อัปโหลดสำเร็จ", at: c.updated_at, tone: "success" });
    if (c.status === "dead" && c.updated_at) events.push({ label: "อัปโหลดไม่สำเร็จ", at: c.updated_at, tone: "danger" });
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
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
  if (owner && conversion.last_error !== null) {
    rows.push(["ข้อผิดพลาดล่าสุด (Last error)", (
      <details>
        <summary>ดูข้อความ (Show)</summary>
        <pre className="hint" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{conversion.last_error}</pre>
      </details>
    )]);
  }
  return <Fields label="Conversion" rows={rows} />;
}

/**
 * One lead. On its own it is a full screen with a back button. With `panel` it is the right-hand panel of the lead list:
 * the same data in narrow sections, a heading of level 2 and a close button instead of the back button.
 */
export function LeadDetailScreen({ me, leadId, onBack, panel = false }: { me: Me; leadId: string; onBack: () => void; panel?: boolean }) {
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

  const close = <button type="button" className="btn lead-close" onClick={onBack} aria-label="ปิดรายละเอียด">ปิด</button>;
  if (missing) return panel
    ? <aside className="lead-panel" aria-label="รายละเอียดลีด"><div className="lead-panel-sec"><p role="status">ไม่พบลีดนี้</p><p className="hint"><code>{leadId}</code></p>{close}</div></aside>
    : <NotFound title="ไม่พบลีดนี้" hint={leadId} />;

  const back = <button type="button" className="btn" onClick={onBack}>← กลับรายการลีด (Back to leads)</button>;
  if (error) return panel ? <aside className="lead-panel" aria-label="รายละเอียดลีด"><div className="lead-panel-sec"><p role="alert">{error}</p>{close}</div></aside> : <><p role="alert">{error}</p>{back}</>;
  if (!lead) return panel ? <aside className="lead-panel" aria-label="รายละเอียดลีด"><div className="lead-panel-sec"><Spinner /></div></aside> : <Spinner />;
  const sec = panel ? "lead-panel-sec" : "panel";
  const secStyle = panel ? undefined : { marginTop: 16 };

  const outcome = OUTCOME[lead.outcome];
  const showPayout = me.role === "owner";
  const found = reconcile(lead.postbacks, lead.conversion);
  const postbackColumns: Column<Postback>[] = [
    { key: "event", header: "เหตุการณ์ (Event)", cell: (p) => p.event_type },
    ...(showPayout ? [{ key: "payout", header: "ค่าตอบแทน (Payout)", align: "right" as const, cell: (p: Postback) => (p.payout === null ? "" : money(p.payout)) }] : []),
    { key: "received", header: "รับเมื่อ (Received)", cell: (p) => fmt(p.created_at) },
  ];

  const events = leadTimeline(lead);
  const click = lead.conversion ? (lead.conversion.click_type !== "none"
    ? <Chip tone="success">มี click id ({CLICK_TYPE[lead.conversion.click_type]})</Chip>
    : <Chip tone="warning">ไม่มี click id</Chip>) : null;
  const timelineSection = (
    <section className={sec} style={secStyle} aria-labelledby="lead-timeline">
      <h3 id="lead-timeline">ไทม์ไลน์</h3>
      {click && <p className="lead-chips">{click}</p>}
      <ol className="lead-timeline" aria-label="ไทม์ไลน์ลีด">
        {events.map((e, i) => <li key={`${e.label}|${e.at}|${i}`}><span className="tl-dot" data-tone={e.tone} aria-hidden="true" /><div><p>{e.label}</p><p className="tl-time">{fmt(e.at)}</p></div></li>)}
      </ol>
    </section>
  );

  const pageHead = panel ? (
    <div className="lead-panel-head">
      <div>
        <h2>รายละเอียดลีด</h2>
        <p className="sub" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "4px 0 0" }}>
          <BrandLabel brandId={lead.brand_id} domain={lead.hostname} />
          <StatusBadge tone={outcome.tone} label={outcome.label} />
        </p>
        <p className="sub" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "4px 0 0" }}>
          <code>{lead.lead_id}</code>
          <button type="button" className="btn" onClick={() => { void copy(); }}>{copied ? "คัดลอกแล้ว" : "คัดลอก"}</button>
        </p>
      </div>
      {close}
    </div>
  ) : (
    <div className="head" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <div>
        <h1>รายละเอียดลีด</h1>
        <p className="sub" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <BrandLabel brandId={lead.brand_id} domain={lead.hostname} />
          <StatusBadge tone={outcome.tone} label={outcome.label} />
          <code>{lead.lead_id}</code>
          <button type="button" className="btn" onClick={() => { void copy(); }}>{copied ? "คัดลอกแล้ว" : "คัดลอก"}</button>
        </p>
      </div>
      {back}
    </div>
  );

  const body = <>
    <section className={sec} style={secStyle} aria-label="ลีด">
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

    {timelineSection}

    <section className={sec} style={secStyle} aria-labelledby="lead-applicant">
      <h2 id="lead-applicant">ผู้สมัคร (Applicant)</h2>
      {lead.applicant ? <Applicant applicant={lead.applicant} /> : <p className="hint">ข้อมูลส่วนบุคคลสงวนสำหรับ Owner (Personal data is owner-only)</p>}
    </section>

    <section className={sec} style={secStyle} aria-labelledby="lead-profile">
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

    <section className={sec} style={secStyle} aria-labelledby="lead-inspector">
      <h2 id="lead-inspector">Postback Inspector</h2>
      {found && <p role="status" aria-label="ตรวจยอด (Reconciliation)"><StatusBadge tone={found.tone} label={found.text} /></p>}
      <DataTable label="Postback" columns={postbackColumns} rows={lead.postbacks.map((p, index) => ({ ...p, index }))} rowKey={(p) => `${p.event_type}|${p.created_at}|${p.index}`}
        empty={<EmptyState title="ยังไม่มี postback (No postbacks yet)" />} />
      <h3 style={{ marginTop: 16 }}>Conversion</h3>
      {lead.conversion ? <Conversion conversion={lead.conversion} owner={showPayout} /> : <p className="hint">ไม่มีรายการอัปโหลด (No conversion upload)</p>}
    </section>
  </>;
  return panel ? <aside className="lead-panel" aria-label="รายละเอียดลีด">{pageHead}{body}</aside> : <>{pageHead}{body}</>;
}
