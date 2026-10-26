import {
  AdkitProject, BRAND_PATCH_FIELD_GROUPS, GoogleAdsAccount, GoogleConversionAction, MicrosoftAdsAccount, SITE_TEXT_LIMITS,
  SiteBrandName, SiteDescription, SiteTitle, roleAtLeast,
  CONVERSION_SETUP_MAX_ATTEMPTS, type BrandConfig, type BrandPatchRequest, type ConversionSetupState, type FlowGateMode, type TemplateTextDefaults,
} from "@anjuna/contracts";
import { Fragment, useCallback, useEffect, useState } from "react";
import type { BrandEditState } from "../../shared/brand-edit";
import { replaceTemplateBrand } from "../../shared/site-text-preview";
import { PANEL_ROLE_TABLE } from "../../server/panel-roles";
import { ApiError, api, type Me } from "../api";
import { useBrandDomains } from "../brand-labels";
import { useConfirm } from "../components/ConfirmDialog";
import { flowGateLabel } from "../labels";
import { isPlainLeftClick, navigate } from "../router";
import { formatSetting } from "../settings-draft";
import { BrandAssetsSection, TemplateVersionSection } from "./BrandEditSections";

/** The UI hides what the role cannot do; the server enforces it regardless. */
const can = (me: Me, group: keyof typeof BRAND_PATCH_FIELD_GROUPS) => roleAtLeast(me.role, BRAND_PATCH_FIELD_GROUPS[group].min_role);

/**
 * brandName: the display name typed at brand creation (brands.name), which the brand Worker serves when no brand name was edited.
 * onOperationStarted: a redeploy or rollback was accepted; the lifecycle view follows it from there.
 */
export function ConfigPanel({ me, brandId, brandName, onClose, onChanged, onOperationStarted }: { me: Me; brandId: string; brandName?: string; onClose: () => void; onChanged: () => void; onOperationStarted?: (installId: string) => void }) {
  const [brand, setBrand] = useState<BrandConfig | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<TemplateTextDefaults | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const domains = useBrandDomains();
  useEffect(() => { void api.siteTextDefaults(brandId).then((r) => setDefaults(r.defaults), () => setDefaults(null)); }, [brandId]);

  // The template version and Microsoft Ads account of the current revision: Owner fields.
  const [edit, setEdit] = useState<BrandEditState | null | undefined>(undefined);
  const isOwner = roleAtLeast(me.role, PANEL_ROLE_TABLE.redeployBrand);
  const loadEdit = useCallback(() => api.brandEdit(brandId).then(setEdit, () => setEdit(null)), [brandId]);
  useEffect(() => { if (isOwner) void loadEdit(); }, [isOwner, loadEdit]);

  const load = useCallback(() => api.brand(brandId).then(setBrand, (e) => setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ" })), [brandId]);
  useEffect(() => void load(), [load]);

  /** Runs one request, reloads the brand and the list, and reports the outcome. */
  async function act<T>(fn: () => Promise<T>, okText: string): Promise<T | undefined> {
    setToast(null);
    try {
      const r = await fn();
      setToast({ kind: "ok", text: okText });
      await load();
      onChanged();
      return r;
    } catch (e) {
      setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "ไม่สำเร็จ" });
      if (e instanceof ApiError && e.status === 409) await load();
      return undefined;
    }
  }

  const save = (body: BrandPatchRequest, okText = "บันทึกแล้ว") =>
    act(() => api.patchBrand(brandId, { ...body, expected_updated_at: brand?.updated_at }), okText);

  if (!brand) return <Drawer onClose={onClose} title={domains.get(brandId) ?? "กำลังโหลด… (Loading)"}>{toast ? <div className="error">{toast.text}</div> : <div className="muted">กำลังโหลด…</div>}</Drawer>;

  return (
    <Drawer onClose={onClose} title={brand.hostnames[0]!}>
      {toast && <div className={toast.kind === "ok" ? "ok" : "error"} role="status">{toast.text}</div>}
      <p className="muted small">
        บัญชี (Account) {brand.account} · <span className={`pill ${brand.status === "live" ? "p-live" : "p-warn"}`}>{brand.status}</span> · ฟอร์ม (form) <code>{brand.form_version ?? "—"}</code>
      </p>

      <Section title="สถานะ (Pause / Resume)">
        {(brand.status !== "live" || me.role === "owner") && <button
          className={brand.status === "live" ? "btn warn" : "btn pri"}
          onClick={async () => {
            const pausing = brand.status === "live";
            const ok = await confirm({
              title: pausing ? "หยุดแบรนด์นี้ชั่วคราว?" : "เปิดแบรนด์นี้ต่อ?",
              body: pausing ? "Pause stops new leads on this brand until it is resumed." : "Resume starts taking leads again.",
              confirmLabel: pausing ? "หยุดชั่วคราว (Pause)" : "เปิดใช้งานต่อ (Resume)",
              tone: pausing ? "danger" : "default",
            });
            if (!ok) return;
            await act(() => api.setStatus(brandId, pausing ? "pause" : "resume"), pausing ? "หยุดแบรนด์แล้ว" : "เปิดแบรนด์แล้ว");
          }}
        >
          {brand.status === "live" ? "หยุดชั่วคราว (Pause)" : "เปิดใช้งานต่อ (Resume)"}
        </button>}
      </Section>

      <KeywordSection key={brand.updated_at} brand={brand} onSave={(k) => save({ keyword_default: k })} />

      {can(me, "site_text") && (
        <SiteTextSection key={`s${brand.updated_at}${defaults ? "d" : ""}`} brand={brand} brandName={brandName ?? null} defaults={defaults}
          onSave={(patch) => save(patch, "บันทึกข้อความหน้าเว็บแล้ว (Site text saved)")} />
      )}

      {roleAtLeast(me.role, PANEL_ROLE_TABLE.editBrandAssets) && <BrandAssetsSection key={`a${brandId}`} brandId={brandId} brandName={brandName ?? brand.hostnames[0]!} />}

      {isOwner && <>
        <Section title="ย้อนกลับ (Rollback)">
          <button
            className="btn"
            onClick={async () => {
              const ok = await confirm({
                title: "ย้อนกลับแบรนด์นี้เป็นเวอร์ชันก่อนหน้า?",
                body: "Roll the brand back to its previous version.",
                confirmLabel: "ย้อนกลับ (Rollback)",
                tone: "danger",
              });
              if (!ok) return;
              const started = await act(() => api.rollbackLifecycle(brandId), "เริ่มย้อนกลับแล้ว ดูสถานะในหน้า Lifecycle (Rollback started, follow it in the lifecycle view)");
              if (started) onOperationStarted?.(started.install_id);
            }}
          >
            ย้อนกลับเป็นเวอร์ชันก่อนหน้า (Rollback)
          </button>
        </Section>
        <TemplateVersionSection
          key={`t${edit?.template_version_id ?? "?"}`}
          currentId={edit?.template_version_id ?? null}
          onChange={async (target) => {
            const ok = await confirm({
              title: `ย้ายแบรนด์นี้ไปเทมเพลต ${target.name} v${target.version} และติดตั้งใหม่?`,
              body: `Move this brand to ${target.name} v${target.version} and redeploy. If a step fails it rolls back to the current version.`,
              confirmLabel: "ย้ายเทมเพลต (Move template)",
            });
            if (!ok) return false;
            const started = await act(() => api.redeploy(brandId, undefined, target.template_version_id), "เริ่มติดตั้งใหม่แล้ว ดูสถานะในหน้า Lifecycle (Redeploy started, follow it in the lifecycle view)");
            if (!started) return false;
            onOperationStarted?.(started.install_id);
            await loadEdit();
            return true;
          }}
        />
      </>}

      {can(me, "ab_weights") && <AbSummary brand={brand} />}
      {can(me, "amount_buckets") && <BucketsSection key={`b${brand.updated_at}`} brand={brand} onSave={(b) => save({ amount_buckets: b })} />}
      {can(me, "flow_gate_mode") && (
        <Section title="เกตของโฟลว์ (Flow gate)">
          <select
            value={brand.flow_gate_mode}
            onChange={async (e) => {
              const next = e.target.value as FlowGateMode;
              const ok = await confirm({
                title: `เปลี่ยนเกตของโฟลว์เป็น ${flowGateLabel[next]}?`,
                body: "Changes how visitors move from the landing page to the form.",
                confirmLabel: "เปลี่ยน (Change)",
              });
              if (!ok) return;
              await save({ flow_gate_mode: next });
            }}
          >
            <option value="param">{flowGateLabel.param}</option>
            <option value="signed_cookie">{flowGateLabel.signed_cookie}</option>
          </select>
        </Section>
      )}
      {can(me, "money_routing") && (
        <MoneySection
          key={`m${brand.updated_at}${edit ? edit.microsoft_ads_account ?? "-" : "?"}`}
          brand={brand}
          microsoft={edit ? edit.microsoft_ads_account : undefined}
          onSaveMicrosoft={async (account) => { if (await act(() => api.setMicrosoftAds(brandId, account), "บันทึกบัญชี Microsoft Ads แล้ว (Microsoft Ads account saved)")) await loadEdit(); }}
          onSave={(m) => save(m)}
          onRotate={async () => {
            const ok = await confirm({
              title: "หมุน (rotate) postback token?",
              body: "ต้องอัปเดต URL ใน LeadsGate ทันที",
              confirmLabel: "หมุน token (Rotate token)",
              tone: "danger",
            });
            if (!ok) return;
            const r = await act(() => api.patchBrand(brandId, { rotate_postback_token: true, expected_updated_at: brand.updated_at }), "หมุน token แล้ว");
            if (r?.issued_postback_token) setIssuedToken(r.issued_postback_token);
          }}
        />
      )}

      {issuedToken && <TokenModal token={issuedToken} onClose={() => setIssuedToken(null)} />}
      {confirmDialog}
    </Drawer>
  );
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="drawer-wrap">
      <div className="scrim" onClick={onClose} />
      <aside className="drawer config-drawer" aria-label="การตั้งค่าแบรนด์ (Brand config)">
        <header>
          <h2>{title}</h2>
          <button className="link" onClick={onClose}>ปิด (Close)</button>
        </header>
        {children}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function KeywordSection({ brand, onSave }: { brand: BrandConfig; onSave: (k: string | null) => void }) {
  const [v, setV] = useState(brand.keyword_default ?? "");
  return (
    <Section title="คีย์เวิร์ดเริ่มต้น (Keyword default)">
      <div className="row">
        <input value={v} maxLength={60} onChange={(e) => setV(e.target.value)} placeholder="ว่าง = ใช้ข้อความเริ่มต้นของ template" />
        <button className="btn pri" onClick={() => onSave(v.trim() === "" ? null : v.trim())}>บันทึก (Save)</button>
      </div>
    </Section>
  );
}

/** A/B weights are edited in Settings only (spec polish D8.2); this is a read-only line with a link. */
function AbSummary({ brand }: { brand: BrandConfig }) {
  const href = `/settings?brand=${encodeURIComponent(brand.brand_id)}`;
  return (
    <Section title="น้ำหนัก A/B (A/B weights)">
      <div className="row split">
        <span>{formatSetting("ab_config", brand.ab_config)}</span>
        <a className="btn" href={href} onClick={(e) => { if (!isPlainLeftClick(e)) return; e.preventDefault(); navigate(href); }}>แก้ไขใน Settings (Edit in Settings)</a>
      </div>
    </Section>
  );
}

function BucketsSection({ brand, onSave }: { brand: BrandConfig; onSave: (b: number[]) => void }) {
  const [text, setText] = useState(brand.amount_buckets.join(", "));
  const parsed = text.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const valid = parsed.length > 0 && parsed.every((n, i) => Number.isInteger(n) && n > 0 && (i === 0 || n > parsed[i - 1]!));
  return (
    <Section title="ช่วงยอดเงิน (Amount buckets)">
      <div className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label="ช่วงยอดเงิน (Amount buckets)" />
        <button className="btn pri" disabled={!valid} onClick={() => onSave(parsed)}>บันทึก (Save)</button>
      </div>
      {!valid && <div className="error small">ใส่ตัวเลขจำนวนเต็ม เรียงจากน้อยไปมาก คั่นด้วยจุลภาค</div>}
    </Section>
  );
}

type RouteField = "google_ads_account" | "google_conversion_action" | "adkit_project";
/** Drain route served to the VPS drain as BRAND_ROUTING_JSON. Empty input clears the field (null). */
const ROUTE_FIELDS: { field: RouteField; label: string; schema: typeof GoogleAdsAccount }[] = [
  { field: "google_ads_account", label: "บัญชี Google Ads (Google Ads account)", schema: GoogleAdsAccount },
  { field: "google_conversion_action", label: "รหัส conversion action (Conversion action)", schema: GoogleConversionAction },
  { field: "adkit_project", label: "โปรเจกต์ AdKit (AdKit project)", schema: AdkitProject },
];

/** Status of the auto-created conversion action. A failed load shows nothing and never blocks saving. */
function ConversionSetupLine({ setup }: { setup: ConversionSetupState | null }) {
  if (!setup || setup.status === "none") return null;
  const text =
    setup.status === "pending" ? "รอสร้างอัตโนมัติ (Pending)"
    : setup.status === "created" ? `สร้างแล้ว (Created)${setup.name ? ` ${setup.name}` : ""}`
    : `สร้างไม่สำเร็จ (Failed)${setup.error ? ` ${setup.error}` : ""} ครั้งที่ ${setup.attempts}/${CONVERSION_SETUP_MAX_ATTEMPTS}`;
  return <div role="status" className={`small ${setup.status === "failed" ? "error" : "muted"}`}>{text}</div>;
}

/** microsoft: undefined while it loads or when it could not be read; null = not set. It lives in the brand profile, not in core, so the drain never reads it. */
function MoneySection({ brand, microsoft, onSave, onSaveMicrosoft, onRotate }: { brand: BrandConfig; microsoft: string | null | undefined; onSave: (m: BrandPatchRequest) => void; onSaveMicrosoft: (account: string | null) => void; onRotate: () => void }) {
  const [ms, setMs] = useState(microsoft ?? "");
  const msValue = ms.trim() === "" ? null : ms.trim();
  const msInvalid = msValue !== null && !MicrosoftAdsAccount.safeParse(msValue).success;
  const [aid, setAid] = useState(brand.aid);
  const [prepop, setPrepop] = useState(brand.prepop_base);
  const [drain, setDrain] = useState(brand.drain_key);
  const [route, setRoute] = useState<Record<RouteField, string>>({
    google_ads_account: brand.google_ads_account ?? "",
    google_conversion_action: brand.google_conversion_action ?? "",
    adkit_project: brand.adkit_project ?? "",
  });
  // MoneySection remounts after every save (keyed by updated_at), so this one load also covers a reload after a save.
  const [setup, setSetup] = useState<ConversionSetupState | null>(null);
  useEffect(() => { void api.conversionSetup(brand.brand_id).then(setSetup, () => setSetup(null)); }, [brand.brand_id]);
  const routeValue = (field: RouteField) => route[field].trim() || null;
  const routeInvalid = ROUTE_FIELDS.filter(({ field, schema }) => routeValue(field) !== null && !schema.safeParse(routeValue(field)).success);
  return (
    <Section title="เส้นทางเงิน (Money-path, Owner เท่านั้น)">
      <label>รหัส LeadsGate (LeadsGate aid)<input value={aid} onChange={(e) => setAid(e.target.value)} /></label>
      <label>URL ฐาน prepop (Prepop base)<input value={prepop} onChange={(e) => setPrepop(e.target.value)} /></label>
      <label>คีย์ drain (Drain key)<input value={drain} onChange={(e) => setDrain(e.target.value)} /></label>
      {ROUTE_FIELDS.map(({ field, label }) => (
        <Fragment key={field}>
          <label>
            {label}
            <input
              value={route[field]}
              aria-invalid={routeInvalid.some((f) => f.field === field) || undefined}
              onChange={(e) => setRoute({ ...route, [field]: e.target.value })}
            />
          </label>
          {field === "google_conversion_action" && <ConversionSetupLine setup={setup} />}
        </Fragment>
      ))}
      {routeInvalid.length > 0 && (
        <div className="error small">บัญชี 10 หลักไม่มีขีด, conversion action เป็นตัวเลข, โปรเจกต์ใช้ A-Z 0-9 _ - (Account 10 digits, action digits, project A-Z 0-9 _ -)</div>
      )}
      <button
        className="btn pri"
        disabled={routeInvalid.length > 0}
        onClick={() =>
          onSave({
            ...(aid !== brand.aid && { aid }),
            ...(prepop !== brand.prepop_base && { prepop_base: prepop }),
            ...(drain !== brand.drain_key && { drain_key: drain }),
            ...Object.fromEntries(ROUTE_FIELDS.map(({ field }) => [field, routeValue(field)])
              .filter(([field, value]) => value !== brand[field as RouteField])),
          })
        }
      >
        บันทึก (Save)
      </button>
      <label>
        บัญชี Microsoft Ads (Microsoft Ads account)
        <input
          value={ms}
          inputMode="numeric"
          disabled={microsoft === undefined}
          aria-invalid={msInvalid || undefined}
          placeholder={microsoft === undefined ? "ไม่สามารถอ่านค่าได้ (Not available)" : "6–12 หลัก (6 to 12 digits)"}
          onChange={(e) => setMs(e.target.value)}
        />
      </label>
      {msInvalid && <div className="error small">ต้องเป็นเลข 6 ถึง 12 หลัก (6 to 12 digits)</div>}
      <div className="row split">
        <span className="muted small">เก็บในโปรไฟล์แบรนด์ ไม่ส่งให้ drain (Stored in the brand profile, the drain does not read it)</span>
        <button className="btn pri" disabled={microsoft === undefined || msInvalid || msValue === microsoft} onClick={() => onSaveMicrosoft(msValue)}>
          บันทึกบัญชี Microsoft Ads (Save Microsoft Ads account)
        </button>
      </div>
      <div className="row split">
        <span>โทเคน postback (Postback token): <b>{brand.postback_token === "set" ? "ตั้งค่าแล้ว (เฉพาะเว็บนี้)" : brand.postback_token === "global" ? "ใช้ postback กลาง (global)" : "ยังไม่ได้ตั้งค่า"}</b></span>
        <button className="btn danger" onClick={onRotate}>หมุนโทเคน (Rotate token)</button>
      </div>
    </Section>
  );
}

function TokenModal({ token, onClose }: { token: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-wrap" role="dialog" aria-modal="true" aria-label="โทเคน postback ใหม่ (New postback token)">
      <div className="card modal">
        <h2>โทเคน postback ใหม่ (New postback token)</h2>
        <div className="warn">คุณจะไม่เห็น token นี้อีก (you will not see this again) — คัดลอกแล้วนำไปใส่ใน LeadsGate postback URL ทันที</div>
        <code className="token">{token}</code>
        <div className="row">
          <button
            className="btn pri"
            onClick={async () => {
              await navigator.clipboard?.writeText(token).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? "คัดลอกแล้ว (Copied)" : "คัดลอก (Copy)"}
          </button>
          <button className="btn" onClick={onClose}>ปิด (Close)</button>
        </div>
      </div>
    </div>
  );
}

type SiteField = "brand_name" | "site_title" | "site_description";
const SITE_FIELDS: Array<{ field: SiteField; source: keyof TemplateTextDefaults; label: string; max: number; schema: typeof SiteTitle }> = [
  { field: "brand_name", source: "brand_name", label: "ชื่อแบรนด์ (Brand name)", max: SITE_TEXT_LIMITS.brand_name, schema: SiteBrandName },
  { field: "site_title", source: "title", label: "ชื่อหน้า (Page title)", max: SITE_TEXT_LIMITS.title, schema: SiteTitle },
  { field: "site_description", source: "description", label: "คำอธิบาย (Meta description)", max: SITE_TEXT_LIMITS.description, schema: SiteDescription },
];

/**
 * Brand name, page title and meta description, editable per brand. The brand name defaults to the brand's display name
 * (else the template's); title and description default to the template. Empty or equal to the default saves null.
 */
function SiteTextSection({ brand, brandName, defaults, onSave }: { brand: BrandConfig; brandName: string | null; defaults: TemplateTextDefaults | null; onSave: (patch: BrandPatchRequest) => void }) {
  const fromBrand = (f: (typeof SITE_FIELDS)[number]) => f.field === "brand_name" && !!brandName;
  const fallback = (f: (typeof SITE_FIELDS)[number]) => (fromBrand(f) ? brandName : defaults?.[f.source]) ?? "";
  const [values, setValues] = useState<Record<SiteField, string>>(
    () => Object.fromEntries(SITE_FIELDS.map((f) => [f.field, brand[f.field] ?? fallback(f)])) as Record<SiteField, string>,
  );
  const edited = (f: (typeof SITE_FIELDS)[number]) => values[f.field].trim() !== "" && values[f.field].trim() !== fallback(f);
  const errors = SITE_FIELDS.map((f) => {
    const value = values[f.field].trim();
    if (!value) return null;
    const parsed = f.schema.safeParse(value);
    return parsed.success ? null : `${f.label}: ${parsed.error.issues[0]?.message ?? "invalid"}`;
  }).filter((e): e is string => e !== null);
  const patch: BrandPatchRequest = {};
  for (const f of SITE_FIELDS) {
    const next = edited(f) ? values[f.field].trim() : null;
    if (next !== brand[f.field]) patch[f.field] = next;
  }
  const changed = Object.keys(patch).length > 0;
  const shown = (field: SiteField) => values[field].trim() || "-";
  const titleField = SITE_FIELDS.find((f) => f.field === "site_title")!;
  const brandField = SITE_FIELDS.find((f) => f.field === "brand_name")!;
  // An unedited title is served as the template wrote it, with the template brand name replaced by the effective brand name.
  const previewTitle = edited(titleField)
    ? values.site_title.trim()
    : replaceTemplateBrand(fallback(titleField), defaults?.brand_name, values.brand_name.trim() || fallback(brandField)) || "-";

  return (
    <Section title="ข้อความหน้าเว็บ (Site text)">
      {SITE_FIELDS.map((f) => (
        <div key={f.field} className="site-field">
          <div className="row split">
            <span>{f.label}</span>
            <span className="badge">{edited(f) ? "แก้ไขแล้ว (Edited)" : fromBrand(f) ? "จากแบรนด์ (From brand)" : "จากเทมเพลต (From template)"}</span>
          </div>
          <input aria-label={f.label} value={values[f.field]} onChange={(e) => setValues({ ...values, [f.field]: e.target.value })} />
          <div className="row split small">
            <span className={values[f.field].trim().length > f.max ? "error" : "muted"}>{`${values[f.field].trim().length}/${f.max}`}</span>
            <button className="link" aria-label={`รีเซ็ต ${f.label} (${fromBrand(f) ? "Reset to brand name" : "Reset to template"})`} onClick={() => setValues({ ...values, [f.field]: fallback(f) })}>
              {fromBrand(f) ? "รีเซ็ตเป็นชื่อแบรนด์ (Reset to brand name)" : "รีเซ็ตเป็นค่าเทมเพลต (Reset to template)"}
            </button>
          </div>
        </div>
      ))}
      {errors.map((e) => <div key={e} className="error small">{e}</div>)}
      <div className="site-preview" aria-label="ตัวอย่าง (Preview)">
        <div className="preview-tab" aria-label="แท็บเบราว์เซอร์ (Browser tab)">{previewTitle}</div>
        <div className="preview-serp">
          <div className="muted small">{brand.hostnames[0]}</div>
          <div className="preview-serp-title">{previewTitle}</div>
          <div className="small">{shown("site_description")}</div>
        </div>
        <div className="preview-brand"><span className="muted small">Header / footer</span> <b>{values.brand_name.trim() || fallback(brandField) || "-"}</b></div>
      </div>
      <button className="btn pri" disabled={!changed || errors.length > 0} onClick={() => onSave(patch)}>บันทึกข้อความหน้าเว็บ (Save site text)</button>
    </Section>
  );
}
