/**
 * The body of each wizard step. The form lives in BrandWizard and these are controlled inputs; the Tracking step
 * also holds its AdKit directory reads and the conversion action job.
 */
import { COPY_KEYWORD_MARKER, COPY_LIMITS, COPY_TEXT_MAX, SITE_TEXT_LIMITS, type AdkitDirectoryResponse, type AdkitJob, type BrandTheme, type CopyField, type TemplateTextDefaults, type TemplateThemeVars, type TemplateVersionSummary } from "@anjuna/contracts";
import { useEffect, useRef, useState } from "react";
import type { ZoneCheckResponse } from "../../shared/wizard";
import { api } from "../api";
import { ColorPair } from "../components/ColorPair";
import { FIELD_LABEL, TRACKING_TEXT, wizardErrorText } from "./messages";
import { copyFieldErrors, visibleCopyLength, type FieldErrors, type FieldKey, type WizardForm } from "./steps";
import { Chip } from "../components/Chip";

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
  if (zone.state === "checking") return <p role="status" className="hint">กำลังตรวจโซน Cloudflare…</p>;
  if (zone.state === "error") return <p role="status" className="note">{zone.text}</p>;
  const { result } = zone;
  if (result.zone_name === null) {
    return <p role="alert" className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>ไม่พบโซนของโดเมนนี้ในบัญชี Cloudflare ของ tenant ให้ Owner เพิ่มโซนก่อน</p>;
  }
  if (!result.zone_active) {
    return <div role="alert" className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>
      <p>โซน {result.zone_name} ยังไม่ active ตั้ง name server ที่ registrar เป็น:</p>
      <ul>{result.nameservers.map((ns) => <li key={ns}><code>{ns}</code></li>)}</ul>
    </div>;
  }
  if (result.conflicting_records.length > 0) {
    return <div role="alert" className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>
      <p>มี DNS record ที่ขวางการผูกโดเมน ต้องลบก่อนติดตั้ง</p>
      <ul>{result.conflicting_records.map((r) => <li key={`${r.type}${r.name}`}><code>{r.type} {r.name}</code></li>)}</ul>
    </div>;
  }
  return <p role="status" className="note pos" style={{ background: "var(--moneybg)", color: "var(--money)" }}>โซน {result.zone_name} active และไม่มี record ที่ขวาง</p>;
}

export function BrandPanel({ form, errors, set, hasDraft, zone, onCheckZone }: FieldsProps & { hasDraft: boolean; zone: ZoneState; onCheckZone: () => void }) {
  const common = { form, errors, set };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12, marginTop: 12 }}>
      <Field field="name" {...common} required maxLength={60} placeholder="Level Lending" />
      <Field field="domain" {...common} required disabled={hasDraft} placeholder="example.com" hint={hasDraft ? "เปลี่ยนโดเมนไม่ได้หลังสร้างฉบับร่าง" : "โดเมนหลัก ไม่ใช่ www"} />
      <div style={{ gridColumn: "1 / -1" }}>
        <button type="button" className="btn" onClick={onCheckZone} disabled={zone.state === "checking" || !form.domain.trim()} aria-label="ตรวจโซน Cloudflare">ตรวจโซน Cloudflare</button>
      </div>
      <div style={{ gridColumn: "1 / -1" }}><ZoneStatus zone={zone} /></div>
      <Field field="keyword" {...common} required placeholder="Fast cash" hint="คำนี้แสดงในชื่อหน้า คำอธิบายเว็บ และหัวฟอร์ม เมื่อลิงก์โฆษณามีคีย์เวิร์ด" />
      <Field field="phone" {...common} required type="tel" placeholder="+1 (555) 010-0199" />
      <Field field="address" {...common} required placeholder="12 Main St, Austin, TX 78701" />
      <Field field="email" {...common} required type="email" placeholder="help@example.com" />
    </div>
  );
}

export function TemplatePanel({ templates, selected, error, onSelect, theme, onTheme, themeVars }: { templates: TemplateVersionSummary[]; selected: string; error?: string; onSelect: (id: string) => void; theme: BrandTheme | null; onTheme: (next: BrandTheme | null) => void; themeVars?: TemplateThemeVars | null }) {
  // Unknown map (null/undefined) keeps the pickers on; a map with no variables at all turns them off.
  const noVars = !!themeVars && themeVars.primary.length === 0 && themeVars.primary_dark.length === 0 && themeVars.secondary.length === 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12, marginTop: 12 }}>
      {templates.length === 0 && <p role="status">ยังไม่มีเทมเพลตที่อนุมัติ ให้ Owner อนุมัติเทมเพลตก่อน</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 14, gridColumn: "1 / -1" }}>
        {templates.map((t) => (
          <button type="button" key={t.template_version_id} className="panel" style={{ display: "grid", gap: 8, padding: 12, textAlign: "left", color: "var(--ink)", borderColor: t.template_version_id === selected ? "var(--money)" : "var(--line)", boxShadow: t.template_version_id === selected ? "inset 0 0 0 1px var(--money)" : undefined }} aria-pressed={t.template_version_id === selected} onClick={() => onSelect(t.template_version_id)}>
            {t.thumbnail_url ? <img src={t.thumbnail_url} alt={`ตัวอย่าง ${t.name}`} loading="lazy" style={{ width: "100%", aspectRatio: "16 / 10", objectFit: "cover", borderRadius: 6 }} /> : <span className="hint" style={{ display: "grid", placeItems: "center", aspectRatio: "16 / 10", background: "var(--paper)", borderRadius: 6 }}>ไม่มีภาพตัวอย่าง</span>}
            <span style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}><strong>{t.name}</strong><span>v{t.version}</span></span>
            <span className="hint">แบรนด์ที่ใช้: {t.brands_using}</span>
          </button>
        ))}
      </div>
      {error && <p className="neg" role="alert">{error}</p>}
      <div style={{ display: "grid", gap: 8, gridColumn: "1 / -1" }}>
        <h3>สีแบรนด์</h3>
        {noVars && <p role="note" className="hint">เทมเพลตนี้ยังไม่รองรับการเปลี่ยนสี</p>}
        <ColorPair value={theme} onChange={onTheme} disabled={noVars} />
      </div>
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
      <p className="hint" style={{ gridColumn: "1 / -1" }}>เว้นว่าง = ใช้ข้อความจากเทมเพลต · H1, CTA และข้อความรองที่เว้นว่างจะถูกเติมตอนสร้างเว็บไซต์</p>
      {COPY_FIELDS.map(({ field, max, source }) => {
        const fallback = field === "brand_name" ? form.name.trim() || templateText?.brand_name : source ? templateText?.[source] : null;
        const count = isPageCopy(field) ? `${visibleCopyLength(form, field)}/${COPY_LIMITS[field]}` : `${form[field].trim().length}/${max}`;
        const slot = field === "h1" ? ` · ใส่ ${COPY_KEYWORD_MARKER} หนึ่งครั้ง (ตำแหน่งนี้แสดงชื่อเว็บไซต์)` : "";
        return <Field key={field} field={field} form={form} errors={shown} set={set} maxLength={max} placeholder={fallback ?? undefined} hint={`${count}${slot}${fallback ? ` · ค่าเริ่มต้น: ${fallback}` : ""}`} />;
      })}
    </div>
  );
}

/**
 * Polling of a pending conversion action job: every `ms`, doubled after each failed read up to `backoffMaxMs`,
 * and stopped `maxMs` after the job started (the step then offers a manual check). Tests lower them.
 */
export const ADKIT_POLL = { ms: 5000, backoffMaxMs: 60_000, maxMs: 30 * 60_000 };

/** First 32 hex characters (128 bits) of the SHA-256 of `text`. */
async function sha256Hex32(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One job per draft, project and account. Core keys jobs by this string, so a changed account or project gets a
 * new job and the same selection finds its earlier job. Max 140 characters, leaving room for a retry suffix.
 * The project segment is `none` for no project, `r:<id>` for an id kept as is (no colon, key fits), and
 * `h:<sha256 hex>` otherwise. The three forms cannot produce the same key for two different projects.
 */
export async function conversionJobKey(draftId: string, project: string, account: string): Promise<string> {
  const head = `conversion_action.create:${draftId}`;
  if (!project) return `${head}:none:${account}`;
  const raw = `${head}:r:${project}:${account}`;
  if (/^[A-Za-z0-9._-]+$/.test(project) && raw.length <= 140) return raw;
  return `${head}:h:${await sha256Hex32(project)}:${account}`;
}

const POLL_START = { since: 0, failures: 0, stopped: false };

type Directory = { state: "idle" } | { state: "loading" } | { state: "ready"; data: AdkitDirectoryResponse } | { state: "error" };
type DirectoryItem = AdkitDirectoryResponse["items"][number];

/** Fresh rows, or null when nothing is fresh: core serves no row older than 2 hours and `synced_at` is null then. */
const freshItems = (d: Directory): DirectoryItem[] | null =>
  d.state === "ready" && d.data.synced_at !== null && d.data.items.length > 0 ? d.data.items : null;

/** Loads once per `key`; `load` null means nothing to load. */
function useDirectory(load: (() => Promise<AdkitDirectoryResponse>) | null, key: string): Directory {
  const [directory, setDirectory] = useState<Directory>({ state: "idle" });
  useEffect(() => {
    if (!load) { setDirectory({ state: "idle" }); return; }
    let active = true;
    setDirectory({ state: "loading" });
    load().then((data) => { if (active) setDirectory({ state: "ready", data }); }, () => { if (active) setDirectory({ state: "error" }); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return directory;
}

/** A select filled from the directory. A saved value missing from the fresh rows stays as its own option. */
function DirectorySelect({ label, value, directory, placeholder, describe, disabled, error, onChange }: {
  label: string; value: string; directory: Directory; placeholder: string; disabled?: boolean; error?: string;
  describe: (item: DirectoryItem) => string; onChange: (value: string) => void;
}) {
  const items = freshItems(directory);
  const missing = value !== "" && !items?.some((item) => item.id === value);
  return (
    <div style={{ display: "grid", gap: 4, alignContent: "start", minWidth: 0 }}>
      <label>
        {label}
        <select aria-label={label} value={value} disabled={disabled || items === null} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)}>
          {items === null && !missing && <option value="">—</option>}
          {items !== null && <option value="">{placeholder}</option>}
          {items?.map((item) => <option key={item.id} value={item.id}>{describe(item)}</option>)}
          {missing && <option value={value}>{`${value} · ${TRACKING_TEXT.notListed}`}</option>}
        </select>
      </label>
      {error && <p className="neg" role="alert">{error}</p>}
    </div>
  );
}

const READ_ONLY_FIELDS: Array<[FieldKey, string]> = [
  ["adkit_project", TRACKING_TEXT.project], ["google_ads_account", TRACKING_TEXT.account], ["google_conversion_action", TRACKING_TEXT.conversion],
];

/**
 * Step 4: project and account are selects from the AdKit directory the VPS syncs hourly. The conversion action is
 * created by a job (POST /api/v1/adkit/conversion-actions), read again by repeating the idempotent call until it is
 * done or failed. No free text. The Microsoft Ads account left the wizard for the global settings.
 */
export function TrackingPanel({ form, errors, set, canEdit, draftId, saveAds }: FieldsProps & { canEdit: boolean; draftId: string | null; saveAds: () => Promise<void> }) {
  const projects = useDirectory(canEdit ? api.adkitProjects : null, String(canEdit));
  const project = form.adkit_project;
  const accounts = useDirectory(canEdit && project ? () => api.adkitAccounts(project) : null, `${canEdit}:${project}`);
  const [job, setJob] = useState<AdkitJob | null>(null);
  const [jobKey, setJobKey] = useState<string | undefined>(undefined);
  const [jobError, setJobError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [poll, setPoll] = useState(POLL_START);
  const pending = job !== null && (job.status === "queued" || job.status === "claimed");
  // The selection on screen now: an answer that arrives after the owner picked another project or account is dropped.
  const selection = useRef({ project, account: form.google_ads_account });
  selection.current = { project, account: form.google_ads_account };

  /**
   * The job's latest state; a done job's action id goes into the form in the same update. A job for another
   * account or project than the one on screen is ignored, so its action id never lands in this selection.
   */
  const take = (next: AdkitJob): boolean => {
    if (next.payload.account !== selection.current.account || (next.payload.project ?? "") !== selection.current.project) return false;
    setJob(next);
    if (next.status === "done" && next.result && "conversion_action_id" in next.result) set("google_conversion_action", next.result.conversion_action_id);
    return true;
  };

  useEffect(() => {
    if (!job || !draftId || !jobKey || (job.status !== "queued" && job.status !== "claimed") || poll.stopped) return;
    if (Date.now() - poll.since >= ADKIT_POLL.maxMs) { setPoll((p) => ({ ...p, stopped: true })); return; }
    let active = true;
    const delay = Math.min(ADKIT_POLL.ms * 2 ** poll.failures, ADKIT_POLL.backoffMaxMs);
    const timer = setTimeout(() => {
      api.createConversionAction(draftId, jobKey).then((r) => {
        if (!active) return;
        setPoll((p) => (p.failures ? { ...p, failures: 0 } : p));
        take(r.job);
      }, () => { if (active) setPoll((p) => ({ ...p, failures: p.failures + 1 })); });
    }, delay);
    return () => { active = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, jobKey, draftId, poll]);

  if (!canEdit) {
    return (
      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        <p role="note" className="note">{TRACKING_TEXT.readOnly}</p>
        {READ_ONLY_FIELDS.map(([field, label]) => <p key={field}>{label}: <b>{form[field] || "—"}</b></p>)}
      </div>
    );
  }

  const resetJob = () => { setJob(null); setJobKey(undefined); setJobError(null); setPoll(POLL_START); };
  async function start(retry = false) {
    if (!draftId) return;
    setStarting(true);
    setJobError(null);
    try {
      const base = await conversionJobKey(draftId, project, form.google_ads_account);
      const key = retry ? `${base}:retry-${Date.now().toString(36)}` : base;
      // The job reads the account and project from the saved draft, so they are saved first.
      await saveAds();
      const r = await api.createConversionAction(draftId, key);
      // A late answer for a selection the owner already left changes nothing, so no key or poll start is kept.
      if (!take(r.job)) return;
      setJobKey(key);
      setPoll({ ...POLL_START, since: Date.now() });
    } catch (e) {
      setJobError(wizardErrorText(e));
    } finally {
      setStarting(false);
    }
  }

  // The currency of the chosen account, read from the AdKit directory. Nothing is typed.
  const currency = freshItems(accounts)?.find((item) => item.id === form.google_ads_account)?.currency ?? null;
  const stale = (projects.state === "ready" && freshItems(projects) === null) || (accounts.state === "ready" && freshItems(accounts) === null);
  const failed = job?.status === "failed" ? (job.result && "error" in job.result ? job.result.error : "") : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 12, marginTop: 12 }}>
      {stale && <p role="status" className="note" style={{ gridColumn: "1 / -1" }}>{TRACKING_TEXT.stale}</p>}
      {(projects.state === "error" || accounts.state === "error") && <p role="status" className="note neg" style={{ gridColumn: "1 / -1" }}>{TRACKING_TEXT.loadFailed}</p>}
      <DirectorySelect label={TRACKING_TEXT.project} value={project} directory={projects} placeholder={TRACKING_TEXT.pickProject} error={errors.adkit_project}
        describe={(item) => item.name}
        onChange={(value) => { set("adkit_project", value); set("google_ads_account", ""); set("google_conversion_action", ""); resetJob(); }} />
      <DirectorySelect label={TRACKING_TEXT.account} value={form.google_ads_account} directory={accounts} placeholder={TRACKING_TEXT.pickAccount} disabled={!project} error={errors.google_ads_account}
        describe={(item) => [item.name, item.id, item.currency].filter(Boolean).join(" · ")}
        onChange={(value) => { set("google_ads_account", value); set("google_conversion_action", ""); resetJob(); }} />
      <div className="currency-strip" style={{ gridColumn: "1 / -1" }}>
        <span>สกุลเงินของบัญชี</span>
        <b className="num">{currency ?? "—"}</b>
        {currency && <Chip tone="info" dot>ตรวจพบอัตโนมัติ</Chip>}
        <small className="muted">ตามบัญชี Google Ads ที่เลือก แก้เองไม่ได้</small>
      </div>
      <div className="wizard-card" style={{ display: "grid", gap: 8, gridColumn: "1 / -1" }}>
        <p><span>{TRACKING_TEXT.conversion}:</span> <b>{form.google_conversion_action || "—"}</b></p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn" onClick={() => void start()} disabled={!draftId || !form.google_ads_account || starting || pending || job?.status === "done"}>{TRACKING_TEXT.create}</button>
          {job && job.status !== "failed" && <span role="status" className="pill">{TRACKING_TEXT.job[job.status]}</span>}
          {failed !== null && <>
            <span role="status" className="neg">{failed ? `${TRACKING_TEXT.job.failed}: ${failed}` : TRACKING_TEXT.job.failed}</span>
            <button type="button" className="btn" disabled={starting} onClick={() => void start(true)}>{TRACKING_TEXT.retry}</button>
          </>}
          {pending && poll.stopped && <>
            <span role="status" className="neg">{TRACKING_TEXT.pollStopped}</span>
            <button type="button" className="btn" onClick={() => setPoll({ ...POLL_START, since: Date.now() })}>{TRACKING_TEXT.checkAgain}</button>
          </>}
        </div>
        {pending && !poll.stopped && poll.failures > 0 && <p role="status" className="note">{TRACKING_TEXT.pollFailed}</p>}
        {!form.google_ads_account && <small className="hint">{TRACKING_TEXT.needAccount}</small>}
        {errors.google_conversion_action && <p className="neg" role="alert">{errors.google_conversion_action}</p>}
        {jobError && <p className="neg" role="alert">{jobError}</p>}
      </div>
    </div>
  );
}
