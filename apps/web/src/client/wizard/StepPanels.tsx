/** The body of each wizard step. All state lives in BrandWizard; these are controlled inputs. */
import { COPY_KEYWORD_MARKER, COPY_LIMITS, COPY_TEXT_MAX, SITE_TEXT_LIMITS, type CopyField, type TemplateTextDefaults, type TemplateVersionSummary } from "@anjuna/contracts";
import type { ZoneCheckResponse } from "../../shared/wizard";
import { FIELD_LABEL } from "./messages";
import { copyFieldErrors, visibleCopyLength, type FieldErrors, type FieldKey, type WizardForm } from "./steps";

export interface FieldsProps {
  form: WizardForm;
  errors: FieldErrors;
  set: (field: FieldKey, value: string) => void;
}

function Field({ field, form, errors, set, hint, ...input }: FieldsProps & { field: FieldKey; hint?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "form">) {
  const error = errors[field];
  return (
    <div style={{ display: "grid", gap: 4, alignContent: "start", minWidth: 0 }}>
      <label>
        {FIELD_LABEL[field].split(" (")[0]}
        <input {...input} aria-label={FIELD_LABEL[field]} value={form[field]} aria-invalid={error ? true : undefined} onChange={(e) => set(field, e.target.value)} />
      </label>
      {hint && <small className="hint">{hint}</small>}
      {error && <p className="neg" role="alert">{error}</p>}
    </div>
  );
}

export type ZoneState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "done"; result: ZoneCheckResponse }
  | { state: "error"; text: string };

/** True when the zone check found something the install would stop on. */
export const zoneBlocks = (zone: ZoneState): boolean =>
  zone.state === "done" && (!zone.result.zone_active || zone.result.conflicting_records.length > 0);

export function ZoneStatus({ zone }: { zone: ZoneState }) {
  if (zone.state === "idle") return null;
  if (zone.state === "checking") return <p role="status" className="hint">กำลังตรวจโซน Cloudflare… (Checking the Cloudflare zone)</p>;
  if (zone.state === "error") return <p role="status" className="note">{zone.text}</p>;
  const { result } = zone;
  if (result.zone_name === null) {
    return <p role="alert" className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>ไม่พบโซนของโดเมนนี้ในบัญชี Cloudflare ของ tenant ให้ Owner เพิ่มโซนก่อน (No zone for this domain in the tenant Cloudflare account, ask the Owner to add it)</p>;
  }
  if (!result.zone_active) {
    return <div role="alert" className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>
      <p>โซน {result.zone_name} ยังไม่ active ตั้ง name server ที่ registrar เป็น: (Zone {result.zone_name} is not active, set these name servers at the registrar)</p>
      <ul>{result.nameservers.map((ns) => <li key={ns}><code>{ns}</code></li>)}</ul>
    </div>;
  }
  if (result.conflicting_records.length > 0) {
    return <div role="alert" className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>
      <p>มี DNS record ที่ขวางการผูกโดเมน ต้องลบก่อนติดตั้ง (These DNS records block the Custom Domain, remove them before install)</p>
      <ul>{result.conflicting_records.map((r) => <li key={`${r.type}${r.name}`}><code>{r.type} {r.name}</code></li>)}</ul>
    </div>;
  }
  return <p role="status" className="note pos" style={{ background: "var(--moneybg)", color: "var(--money)" }}>โซน {result.zone_name} active และไม่มี record ที่ขวาง (Zone {result.zone_name} is active, no blocking records)</p>;
}

export function BrandPanel({ form, errors, set, hasDraft, zone, onCheckZone }: FieldsProps & { hasDraft: boolean; zone: ZoneState; onCheckZone: () => void }) {
  const common = { form, errors, set };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12, marginTop: 12 }}>
      <Field field="name" {...common} required maxLength={60} placeholder="Level Lending" />
      <Field field="domain" {...common} required disabled={hasDraft} placeholder="example.com" hint={hasDraft ? "เปลี่ยนโดเมนไม่ได้หลังสร้างฉบับร่าง (The domain is fixed once the draft exists)" : "โดเมนหลัก ไม่ใช่ www (Apex domain, not www)"} />
      <div style={{ gridColumn: "1 / -1" }}>
        <button type="button" className="btn" onClick={onCheckZone} disabled={zone.state === "checking" || !form.domain.trim()} aria-label="ตรวจโซน Cloudflare (Check Cloudflare zone)">ตรวจโซน Cloudflare</button>
      </div>
      <div style={{ gridColumn: "1 / -1" }}><ZoneStatus zone={zone} /></div>
      <Field field="keyword" {...common} required placeholder="Fast cash" hint="คีย์เวิร์ดเริ่มต้นของโฆษณา (Default ad keyword)" />
      <Field field="phone" {...common} required type="tel" placeholder="+1 (555) 010-0199" />
      <Field field="address" {...common} required placeholder="12 Main St, Austin, TX 78701" />
      <Field field="email" {...common} required type="email" placeholder="help@example.com" />
    </div>
  );
}

export function TemplatePanel({ templates, selected, error, onSelect }: { templates: TemplateVersionSummary[]; selected: string; error?: string; onSelect: (id: string) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12, marginTop: 12 }}>
      {templates.length === 0 && <p role="status">ยังไม่มีเทมเพลตที่อนุมัติ ให้ Owner อนุมัติเทมเพลตก่อน (No approved template yet, ask the Owner to approve one)</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 14, gridColumn: "1 / -1" }}>
        {templates.map((t) => (
          <button type="button" key={t.template_version_id} className="panel" style={{ display: "grid", gap: 8, padding: 12, textAlign: "left", color: "var(--ink)", borderColor: t.template_version_id === selected ? "var(--money)" : "var(--line)", boxShadow: t.template_version_id === selected ? "inset 0 0 0 1px var(--money)" : undefined }} aria-pressed={t.template_version_id === selected} onClick={() => onSelect(t.template_version_id)}>
            {t.thumbnail_url ? <img src={t.thumbnail_url} alt={`ตัวอย่าง ${t.name} (Template preview)`} loading="lazy" style={{ width: "100%", aspectRatio: "16 / 10", objectFit: "cover", borderRadius: 6 }} /> : <span className="hint" style={{ display: "grid", placeItems: "center", aspectRatio: "16 / 10", background: "var(--paper)", borderRadius: 6 }}>ไม่มีภาพตัวอย่าง (No preview)</span>}
            <span style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}><strong>{t.name}</strong><span>v{t.version}</span></span>
            <span className="hint">แบรนด์ที่ใช้ (Brands using): {t.brands_using}</span>
          </button>
        ))}
      </div>
      {error && <p className="neg" role="alert">{error}</p>}
    </div>
  );
}

const COPY_FIELDS: Array<{ field: FieldKey; max: number; source?: keyof TemplateTextDefaults }> = [
  { field: "brand_name", max: SITE_TEXT_LIMITS.brand_name, source: "brand_name" },
  { field: "site_title", max: SITE_TEXT_LIMITS.title, source: "title" },
  { field: "site_description", max: SITE_TEXT_LIMITS.description, source: "description" },
  { field: "h1", max: COPY_TEXT_MAX },
  { field: "cta", max: COPY_TEXT_MAX },
  { field: "sub", max: COPY_TEXT_MAX },
];

/** The h1, cta and sub: checked as the employee types, with the same rules the install applies. */
const isPageCopy = (field: FieldKey): field is CopyField => Object.hasOwn(COPY_LIMITS, field);

export function CopyPanel({ form, errors, set, templateText }: FieldsProps & { templateText: TemplateTextDefaults | null }) {
  // Findings of a filled field show at once; the Next button repeats them. An empty field is not a finding.
  const shown = { ...copyFieldErrors(form), ...errors };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12, marginTop: 12 }}>
      <p className="hint" style={{ gridColumn: "1 / -1" }}>เว้นว่าง = ใช้ข้อความจากเทมเพลต (Leave blank to use the template text) · H1, CTA และข้อความรองที่เว้นว่างจะถูกเติมตอนสร้างเว็บไซต์ (Empty H1, CTA and sub are filled at Generate)</p>
      {COPY_FIELDS.map(({ field, max, source }) => {
        const fallback = field === "brand_name" ? form.name.trim() || templateText?.brand_name : source ? templateText?.[source] : null;
        const count = isPageCopy(field) ? `${visibleCopyLength(form, field)}/${COPY_LIMITS[field]}` : `${form[field].trim().length}/${max}`;
        const slot = field === "h1" ? ` · ใส่ ${COPY_KEYWORD_MARKER} หนึ่งครั้ง (Put ${COPY_KEYWORD_MARKER} once)` : "";
        return <Field key={field} field={field} form={form} errors={shown} set={set} maxLength={max} placeholder={fallback ?? undefined} hint={`${count}${slot}${fallback ? ` · ค่าเริ่มต้น (Default): ${fallback}` : ""}`} />;
      })}
    </div>
  );
}

const TRACKING_FIELDS: FieldKey[] = ["google_ads_account", "google_conversion_action", "adkit_project", "microsoft_ads_account"];

export function TrackingPanel({ form, errors, set, canEdit }: FieldsProps & { canEdit: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12, marginTop: 12 }}>
      {!canEdit && <p role="note" className="note" style={{ gridColumn: "1 / -1" }}>Owner กำหนดค่านี้ (The Owner sets this) · แสดงอย่างเดียว (Read-only)</p>}
      {TRACKING_FIELDS.map((field) => canEdit
        ? <Field key={field} field={field} form={form} errors={errors} set={set} />
        : <p key={field}>{FIELD_LABEL[field]}: <b>{form[field] || "-"}</b></p>)}
    </div>
  );
}
