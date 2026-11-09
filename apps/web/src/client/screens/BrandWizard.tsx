/**
 * New brand wizard: five steps with per-step validation. The first Next creates the draft, every later Next
 * saves it with PATCH /api/brands/:id/draft, and Generate starts the install. A saved draft resumes at its
 * first incomplete step.
 */
import { EMPTY_THEME_VARS, roleAtLeast, type BrandTheme, type TemplateTextDefaults, type TemplateThemeVars, type TemplateVersionSummary, type UpdateBrandDraftRequest } from "@anjuna/contracts";
import { Check } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WizardDefaultsResponse, WizardDraft } from "../../shared/wizard";
import { PANEL_ROLE_TABLE } from "../../server/panel-roles";
import { api, type Me } from "../api";
import { GENERATE_OWNER_ONLY, wizardErrorText } from "../wizard/messages";
import { WizardSummary } from "../wizard/WizardSummary";
import { BrandPanel, CopyPanel, TemplatePanel, TrackingPanel, ZoneStatus, zoneBlocks, type ZoneState } from "../wizard/StepPanels";
import {
  STEPS, STEP_LABEL, adsOf, contactOf, copyOf, emptyForm, firstIncompleteStep, formFromDraft, stepOfField, validateStep,
  type FieldErrors, type FieldKey, type WizardForm,
} from "../wizard/steps";

export interface BrandWizardProps {
  me: Me;
  /** Resume this draft. Absent starts a new brand. */
  brandId?: string;
  /** Open at this step instead of the first incomplete one (a duplicate starts at the Brand step). */
  initialStep?: number;
  onClose: () => void;
  /** The install was accepted: the Lifecycle screen tracks it from here. */
  onGenerated: (brandId: string, installId: string) => void;
}

export function BrandWizard({ me, brandId, initialStep, onClose, onGenerated }: BrandWizardProps) {
  // Step 4 reads the AdKit directory and queues jobs, which core serves to an owner only (useAdkit).
  const canEditTracking = roleAtLeast(me.role, PANEL_ROLE_TABLE.setDraftTracking) && roleAtLeast(me.role, PANEL_ROLE_TABLE.useAdkit);
  // Generate is owner only (spec); an employee fills and saves the draft, and the Owner presses Generate.
  const canGenerate = roleAtLeast(me.role, PANEL_ROLE_TABLE.generateBrand);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [templates, setTemplates] = useState<TemplateVersionSummary[]>([]);
  const [defaults, setDefaults] = useState<WizardDefaultsResponse | null>(null);
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [form, setForm] = useState<WizardForm>(emptyForm);
  const [theme, setTheme] = useState<BrandTheme | null>(null);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  // True right after a Next saved the draft, until the form changes again.
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zone, setZone] = useState<ZoneState>({ state: "idle" });
  const [templateText, setTemplateText] = useState<TemplateTextDefaults | null>(null);
  const [themeVars, setThemeVars] = useState<TemplateThemeVars | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      api.templates(),
      api.wizardDefaults().catch(() => null),
      brandId ? api.wizardDraft(brandId) : Promise.resolve(null),
    ]).then(([list, tenant, existing]) => {
      if (!active) return;
      const approved = list.templates.filter((t) => t.status === "approved");
      setTemplates(approved);
      setDefaults(tenant);
      if (existing) {
        setDraft(existing);
        setForm(formFromDraft(existing));
        setTheme(existing.profile?.theme ?? null);
        setStep(initialStep ?? firstIncompleteStep(existing.profile, { canEditTracking }));
      } else {
        setForm((previous) => ({ ...previous, template_version_id: previous.template_version_id || approved[0]?.template_version_id || "" }));
      }
    }).catch((e: unknown) => {
      if (active) setLoadError(wizardErrorText(e));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [brandId, initialStep, canEditTracking, reload]);

  const ctx = useMemo(() => ({ hasDraft: draft !== null, canEditTracking, templates }), [draft, canEditTracking, templates]);
  const stepId = STEPS[step]!;
  const templateId = form.template_version_id;

  // The Copy step shows the template's own text as the default of each field; the Template step reads its color map.
  useEffect(() => {
    if (!templateId || (stepId !== "template" && stepId !== "copy" && stepId !== "review")) return;
    let active = true;
    setThemeVars(null);
    void api.template(templateId).then((detail) => {
      if (!active) return;
      setTemplateText(detail.template.text_defaults);
      // A version imported before the color map existed answers null: no variables, not "still loading".
      const vars = detail.template.theme_vars ?? EMPTY_THEME_VARS;
      setThemeVars(vars);
      // The pickers are disabled without variables, so a theme stored earlier is dropped here and the next save removes it.
      if (vars.primary.length === 0 && vars.primary_dark.length === 0 && vars.secondary.length === 0) setTheme(null);
    },() => { if (active) { setTemplateText(null); setThemeVars(null); } });
    return () => { active = false; };
  }, [templateId, stepId]);

  const checkZone = useCallback(async () => {
    const domain = form.domain.trim();
    if (!domain) return;
    setZone({ state: "checking" });
    try {
      setZone({ state: "done", result: await api.zoneCheck(domain, draft?.brand.brand_id) });
    } catch (e) {
      setZone({ state: "error", text: wizardErrorText(e) });
    }
  }, [form.domain, draft?.brand.brand_id]);

  // Entering Review re-reads the zone and reloads the preview of what was just saved.
  useEffect(() => {
    if (stepId !== "review") return;
    setPreviewNonce((n) => n + 1);
    void checkZone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId]);

  const set = (field: FieldKey, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors(({ [field]: _removed, ...rest }) => rest);
    setNotice(null);
    setSaved(false);
  };

  async function patch(body: UpdateBrandDraftRequest): Promise<void> {
    const saved = await api.updateDraft(draft!.brand.brand_id, body);
    setDraft({ brand: saved.brand, revision: saved.revision, ...(saved.profile ? { profile: saved.profile } : {}) });
    setForm((previous) => ({ ...previous, keyword: saved.brand.keyword_default ?? previous.keyword }));
  }

  /** The step's data goes to the draft. Groups of other steps stay as the server holds them. */
  async function save(): Promise<void> {
    const profile = draft?.profile ?? {};
    switch (stepId) {
      case "brand": {
        const withContact = { ...profile, contact: contactOf(form) };
        if (!draft) {
          const created = await api.createDraft({ name: form.name.trim(), domain: form.domain.trim(), keyword_default: form.keyword.trim(), template_version_id: form.template_version_id, profile: withContact });
          setDraft(created);
          setForm((previous) => ({ ...previous, domain: created.brand.domain, keyword: created.brand.keyword_default ?? previous.keyword }));
        } else {
          await patch({ name: form.name.trim(), keyword_default: form.keyword.trim(), profile: withContact });
        }
        return;
      }
      case "template": {
        if (form.template_version_id !== draft!.revision.template_version_id) await patch({ template_version_id: form.template_version_id });
        // A null theme means template colors: the key is left out of the profile.
        if (JSON.stringify(theme) !== JSON.stringify(profile.theme ?? null)) {
          const { theme: _stored, ...rest } = profile;
          await patch({ profile: theme ? { ...rest, theme } : rest });
        }
        return;
      }
      case "copy":
        return patch({ profile: { ...profile, copy: copyOf(form) } });
      case "tracking":
        if (canEditTracking) await patch({ profile: { ...profile, ads: adsOf(form) } });
        return;
      case "review":
        return;
    }
  }

  async function next() {
    const found = validateStep(stepId, form, ctx);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setNotice(null);
    try {
      await save();
      setSaved(true);
      setStep((current) => current + 1);
    } catch (e) {
      setNotice(wizardErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!draft || !canGenerate) return;
    const found = validateStep("review", form, ctx);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setStep(stepOfField(Object.keys(found)[0] as FieldKey));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // Generate checks the saved draft server-side and starts the install; the Lifecycle screen then shows InstallProgress.
      const started = await api.generate(draft.brand.brand_id);
      onGenerated(draft.brand.brand_id, started.install_id);
    } catch (e) {
      setNotice(wizardErrorText(e));
      setBusy(false);
    }
  }

  const chosen = templates.find((t) => t.template_version_id === templateId);
  const blocked = zoneBlocks(zone);

  const stepName = (id: (typeof STEPS)[number]) => STEP_LABEL[id];
  return (
    <section className="wizard-page" aria-label="วิซาร์ดแบรนด์ใหม่">
      <button type="button" className="wizard-back" onClick={onClose}>← กลับไปแบรนด์</button>
      <div className="wizard-head">
        <div>
          <h1>สร้างแบรนด์ใหม่</h1>
          <p className="wizard-sub">ขั้นที่ <span className="num">{step + 1}</span> จาก <span className="num">{STEPS.length}</span></p>
        </div>
        {saved && <p className="wizard-saved" role="status"><Check size={16} aria-hidden="true" />บันทึกร่างแล้ว</p>}
      </div>
      <ol className="wizard-stepper" aria-label="ขั้นตอน">
        {STEPS.map((id, index) => {
          const state = index === step ? "current" : index < step ? "done" : "todo";
          const label = <><span className="wizard-num">{index < step ? <Check size={14} aria-hidden="true" /> : index + 1}</span>{stepName(id)}</>;
          return (
            <li key={id} aria-current={index === step ? "step" : undefined} className={`wizard-step ${state}`}>
              {index < step
                ? <button type="button" onClick={() => { setErrors({}); setNotice(null); setStep(index); }}>{label}</button>
                : <span>{label}</span>}
            </li>
          );
        })}
      </ol>
      {loading && <p className="hint" role="status">กำลังโหลด… (Loading)</p>}
      {loadError && <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert"><p>{loadError}</p><button type="button" className="btn" onClick={() => setReload((n) => n + 1)}>ลองใหม่ (Retry)</button></div>}
      {!loading && !loadError && <div className="wizard-grid">
        <div className="wizard-main panel">
          <h2>{STEP_LABEL[stepId]}</h2>
          {stepId === "brand" && <BrandPanel form={form} errors={errors} set={set} hasDraft={draft !== null} zone={zone} onCheckZone={() => void checkZone()} />}
          {stepId === "template" && <TemplatePanel templates={templates} selected={templateId} error={errors.template_version_id} onSelect={(id) => set("template_version_id", id)} theme={theme} onTheme={setTheme} themeVars={themeVars} />}
          {stepId === "copy" && <CopyPanel form={form} errors={errors} set={set} templateText={templateText} />}
          {stepId === "tracking" && <TrackingPanel form={form} errors={errors} set={set} canEdit={canEditTracking} draftId={draft?.brand.brand_id ?? null} saveAds={() => patch({ profile: { ...(draft?.profile ?? {}), ads: adsOf(form) } })} />}
          {stepId === "review" && <ReviewPanel form={form} templateName={chosen ? `${chosen.name} v${chosen.version}` : templateId} defaults={defaults} zone={zone} onCheckZone={() => void checkZone()} previewSrc={draft ? `/api/wizard/preview/${encodeURIComponent(draft.brand.brand_id)}?r=${previewNonce}` : null} canEditTracking={canEditTracking} />}
          {notice && <p className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">{notice}</p>}
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", marginTop: 18 }}>
            <button type="button" className="btn" disabled={busy || step === 0} onClick={() => { setErrors({}); setNotice(null); setStep(step - 1); }}>ย้อนกลับ</button>
            {stepId !== "review"
              ? <button type="button" className="btn pri" disabled={busy || (stepId === "template" && templates.length === 0)} onClick={() => void next()}>ถัดไป</button>
              : <button type="button" className="btn pri" disabled={busy || blocked || !canGenerate} aria-describedby={canGenerate ? undefined : "generate-owner-only"} onClick={() => void generate()}>สร้างเว็บไซต์</button>}
          </div>
          {stepId === "review" && !canGenerate && <p id="generate-owner-only" role="note" className="hint">{GENERATE_OWNER_ONLY}</p>}
        </div>
        <WizardSummary form={form} templateName={chosen ? `${chosen.name} v${chosen.version}` : ""} customTheme={theme !== null} drafted={draft !== null} />
      </div>}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="cell" style={{ overflowWrap: "anywhere" }}><span className="k" style={{ display: "block" }}>{label}</span><b style={{ fontWeight: 500 }}>{value || "-"}</b></div>;
}

function ReviewPanel({ form, templateName, defaults, zone, onCheckZone, previewSrc, canEditTracking }: { form: WizardForm; templateName: string; defaults: WizardDefaultsResponse | null; zone: ZoneState; onCheckZone: () => void; previewSrc: string | null; canEditTracking: boolean }) {
  const fromTemplate = "ใช้ค่าจากเทมเพลต (Template default)";
  return (
    <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
      <h3>สรุป (Summary)</h3>
      <div className="ledger" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
        <Row label="ชื่อแบรนด์ (Brand name)" value={form.name} />
        <Row label="โดเมน (Domain)" value={form.domain} />
        <Row label="คีย์เวิร์ด (Keyword)" value={form.keyword} />
        <Row label="เทมเพลต (Template)" value={templateName} />
        <Row label="โทรศัพท์ (Phone)" value={form.phone} />
        <Row label="อีเมล (Email)" value={form.email} />
        <Row label="ที่อยู่ (Address)" value={form.address} />
        <Row label="ช่วงยอดเงิน (Amount buckets)" value={defaults ? defaults.amount_buckets.join(", ") : ""} />
        <Row label="เส้นทางฟอร์ม (Form route)" value={defaults?.form_route ?? ""} />
        <Row label="ชื่อแบรนด์บนเว็บ (Site brand name)" value={form.brand_name || fromTemplate} />
        <Row label="ชื่อหน้า (Page title)" value={form.site_title || fromTemplate} />
        <Row label="คำอธิบาย (Meta description)" value={form.site_description || fromTemplate} />
        <Row label="H1" value={form.h1} />
        <Row label="CTA" value={form.cta} />
        <Row label="บัญชี Google Ads (Google Ads account)" value={form.google_ads_account} />
        <Row label="conversion action" value={form.google_conversion_action} />
        <Row label="โปรเจกต์ AdKit (AdKit project)" value={form.adkit_project} />
      </div>
      {!canEditTracking && <p className="hint">Owner กำหนดค่าติดตามผล (The Owner sets the tracking ids)</p>}
      <h3>โซน Cloudflare (Cloudflare zone)</h3>
      <ZoneStatus zone={zone} />
      <div className="row"><button type="button" className="btn" onClick={onCheckZone} disabled={zone.state === "checking"}>ตรวจอีกครั้ง (Check again)</button></div>
      {zoneBlocks(zone) && <p className="hint">สร้างไม่ได้จนกว่าโซนจะพร้อม (Generate is off until the zone is ready)</p>}
      <h3>ตัวอย่างก่อนติดตั้ง (Preview before install)</h3>
      {previewSrc && <iframe key={previewSrc} style={{ width: "100%", height: 520, border: "1px solid var(--line)", borderRadius: 10, background: "var(--raised)" }} title="ตัวอย่างหน้าเว็บ (Site preview)" sandbox="" src={previewSrc} />}
    </div>
  );
}
