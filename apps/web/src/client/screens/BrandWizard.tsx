/**
 * New brand wizard: five steps with per-step validation. The first Next creates the draft, every later Next
 * saves it with PATCH /api/brands/:id/draft, and Generate starts the install. A saved draft resumes at its
 * first incomplete step. A live brand opens prefilled from its current revision: every Next keeps the edits in memory,
 * the preview renders them without saving, and the last button sends them as one redeploy after a confirm.
 */
import { EMPTY_THEME_VARS, roleAtLeast, type BrandTheme, type TemplateTextDefaults, type TemplateThemeVars, type TemplateVersionSummary, type UpdateBrandDraftRequest } from "@anjuna/contracts";
import { Check } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WizardDefaultsResponse, WizardDraft } from "../../shared/wizard";
import { PANEL_ROLE_TABLE } from "../../server/panel-roles";
import { api, type Me } from "../api";
import { useConfirm } from "../components/ConfirmDialog";
import { GENERATE_OWNER_ONLY, REDEPLOY_OWNER_ONLY, wizardErrorText } from "../wizard/messages";
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
  const [livePreview, setLivePreview] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const live = draft?.brand.status === "live";
  // A live brand is finished by a redeploy, which is owner only like the ติดตั้งใหม่ button.
  const canFinish = live ? roleAtLeast(me.role, PANEL_ROLE_TABLE.redeployBrand) : canGenerate;
  // A live brand's tracking is changed in Settings: the server refuses it in a redeploy, so the step is read-only here.
  const trackingEditable = canEditTracking && !live;
  // The template a live brand runs now. It stays a valid pick even when archived or outside the template list.
  const [liveTemplateId, setLiveTemplateId] = useState<string | null>(null);

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
        setLiveTemplateId(existing.brand.status === "live" ? existing.revision.template_version_id : null);
        setForm(formFromDraft(existing));
        setTheme(existing.profile?.theme ?? null);
        setStep(initialStep ?? (existing.brand.status === "live" ? 0 : firstIncompleteStep(existing.profile, { canEditTracking })));
      } else {
        setForm((previous) => ({ ...previous, template_version_id: previous.template_version_id || approved[0]?.template_version_id || "" }));
      }
    }).catch((e: unknown) => {
      if (active) setLoadError(wizardErrorText(e));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [brandId, initialStep, canEditTracking, reload]);

  const ctx = useMemo(() => ({ hasDraft: draft !== null, canEditTracking: trackingEditable, templates, currentTemplateId: liveTemplateId }), [draft, trackingEditable, templates, liveTemplateId]);
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

  // Entering Review re-reads the zone and reloads the preview of what was just saved. A live brand keeps its zone and
  // previews the edits held in memory.
  useEffect(() => {
    if (stepId !== "review") return;
    if (live && draft) {
      let active = true;
      setLivePreview(null);
      void api.wizardPreview(draft.brand.brand_id, { template_version_id: draft.revision.template_version_id, ...(draft.profile ? { profile: draft.profile } : {}) })
        .then((html) => { if (active) setLivePreview(html); }, (e: unknown) => { if (active) setNotice(wizardErrorText(e)); });
      return () => { active = false; };
    }
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
    if (live) {
      // Nothing is stored until the redeploy. Name and keyword are locked for a live brand, so only these two move.
      setDraft((current) => current && ({
        ...current,
        revision: { ...current.revision, template_version_id: body.template_version_id ?? current.revision.template_version_id },
        ...(body.profile !== undefined ? { profile: body.profile } : {}),
      }));
      return;
    }
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
        if (trackingEditable) await patch({ profile: { ...profile, ads: adsOf(form) } });
        return;
      case "review":
        return;
    }
  }

  async function next() {
    const from = step;
    const found = validateStep(stepId, form, ctx);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setNotice(null);
    try {
      await save();
      // A live brand's edits are only held in memory, so there is no saved draft to report.
      setSaved(!live);
      setStep((current) => (current === from ? from + 1 : current));
    } catch (e) {
      setNotice(wizardErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!draft || !canFinish) return;
    const found = validateStep("review", form, ctx);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setStep(stepOfField(Object.keys(found)[0] as FieldKey));
      return;
    }
    if (live) {
      const ok = await confirm({
        title: "บันทึกและติดตั้งใหม่?",
        body: `เว็บ ${draft.brand.domain} จะเปลี่ยนตามที่แก้หลังติดตั้งเสร็จ ถ้าเว็บใหม่มีปัญหา กดย้อนกลับได้ที่หน้าแบรนด์`,
        confirmLabel: "บันทึกและติดตั้งใหม่",
      });
      if (!ok) return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // Generate checks the saved draft server-side and starts the install; the Lifecycle screen then shows InstallProgress.
      // A live brand sends its edits as one redeploy: a new revision, so ย้อนกลับ returns to the current one.
      const started = live
        ? await api.wizardRedeploy(draft.brand.brand_id, { template_version_id: draft.revision.template_version_id, ...(draft.profile ? { profile: draft.profile } : {}), ...(draft.base_revision_id ? { base_revision_id: draft.base_revision_id } : {}) })
        : await api.generate(draft.brand.brand_id);
      onGenerated(draft.brand.brand_id, started.install_id);
    } catch (e) {
      setNotice(wizardErrorText(e));
      setBusy(false);
    }
  }

  const chosen = templates.find((t) => t.template_version_id === templateId);
  // A live brand keeps its zone: the wizard does not check it again and the install validates its own records.
  const blocked = !live && zoneBlocks(zone);

  const stepName = (id: (typeof STEPS)[number]) => STEP_LABEL[id];
  return (
    <section className="wizard-page" aria-label={live ? "แก้ไขในวิซาร์ด" : "วิซาร์ดแบรนด์ใหม่"}>
      <button type="button" className="wizard-back" onClick={onClose}>← กลับไปแบรนด์</button>
      <div className="wizard-head">
        <div>
          <h1>{live ? "แก้ไขในวิซาร์ด" : "สร้างแบรนด์ใหม่"}</h1>
          <p className="wizard-sub">ขั้นที่ <span className="num">{step + 1}</span> จาก <span className="num">{STEPS.length}</span></p>
        </div>
        {saved && <p className="wizard-saved" role="status"><Check size={16} aria-hidden="true" />บันทึกร่างแล้ว</p>}
      </div>
      {live && <p className="note" role="note">กำลังแก้แบรนด์ที่ออนไลน์อยู่ เว็บจะเปลี่ยนหลังกดติดตั้ง</p>}
      <ol className="wizard-stepper" aria-label="ขั้นตอน">
        {STEPS.map((id, index) => {
          const state = index === step ? "current" : index < step ? "done" : "todo";
          const label = <><span className="wizard-num">{index < step ? <Check size={14} aria-hidden="true" /> : index + 1}</span>{stepName(id)}</>;
          return (
            <li key={id} aria-current={index === step ? "step" : undefined} className={`wizard-step ${state}`}>
              {index < step
                ? <button type="button" disabled={busy} onClick={() => { setErrors({}); setNotice(null); setStep(index); }}>{label}</button>
                : <span>{label}</span>}
            </li>
          );
        })}
      </ol>
      {loading && <p className="hint" role="status">กำลังโหลด…</p>}
      {loadError && <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert"><p>{loadError}</p><button type="button" className="btn" onClick={() => setReload((n) => n + 1)}>ลองใหม่</button></div>}
      {!loading && !loadError && <div className="wizard-grid">
        <div className="wizard-main panel">
          <h2>{STEP_LABEL[stepId]}</h2>
          {stepId === "brand" && <BrandPanel form={form} errors={errors} set={set} hasDraft={draft !== null} zone={zone} onCheckZone={() => void checkZone()} live={live} />}
          {stepId === "template" && <TemplatePanel templates={templates} selected={templateId} error={errors.template_version_id} onSelect={(id) => set("template_version_id", id)} theme={theme} onTheme={(next) => { setTheme(next); setNotice(null); setSaved(false); }} themeVars={themeVars} />}
          {stepId === "copy" && <CopyPanel form={form} errors={errors} set={set} templateText={templateText} />}
          {stepId === "tracking" && <TrackingPanel form={form} errors={errors} set={set} canEdit={trackingEditable} live={live} draftId={draft?.brand.brand_id ?? null} saveAds={() => patch({ profile: { ...(draft?.profile ?? {}), ads: adsOf(form) } })} />}
          {stepId === "review" && <ReviewPanel form={form} templateName={chosen ? `${chosen.name} v${chosen.version}` : templateId} defaults={defaults} zone={zone} onCheckZone={() => void checkZone()} previewSrc={draft && !live ? `/api/wizard/preview/${encodeURIComponent(draft.brand.brand_id)}?r=${previewNonce}` : null} previewHtml={live ? livePreview : null} live={live} canEditTracking={canEditTracking} />}
          {notice && <p className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">{notice}</p>}
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", marginTop: 18 }}>
            <button type="button" className="btn" disabled={busy || step === 0} onClick={() => { setErrors({}); setNotice(null); setStep(step - 1); }}>ย้อนกลับ</button>
            {stepId !== "review"
              ? <button type="button" className="btn pri" disabled={busy || (stepId === "template" && templates.length === 0 && liveTemplateId === null)} onClick={() => void next()}>ถัดไป</button>
              : <button type="button" className="btn pri" disabled={busy || blocked || !canFinish} aria-describedby={canFinish ? undefined : "generate-owner-only"} onClick={() => void generate()}>{live ? "บันทึกและติดตั้งใหม่" : "สร้างเว็บไซต์"}</button>}
          </div>
          {stepId === "review" && !canFinish && <p id="generate-owner-only" role="note" className="hint">{live ? REDEPLOY_OWNER_ONLY : GENERATE_OWNER_ONLY}</p>}
        </div>
        <WizardSummary form={form} templateName={chosen ? `${chosen.name} v${chosen.version}` : ""} customTheme={theme !== null} drafted={draft !== null} />
      </div>}
      {confirmDialog}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="cell" style={{ overflowWrap: "anywhere" }}><span className="k" style={{ display: "block" }}>{label}</span><b style={{ fontWeight: 500 }}>{value || "-"}</b></div>;
}

function ReviewPanel({ form, templateName, defaults, zone, onCheckZone, previewSrc, previewHtml = null, live = false, canEditTracking }: { form: WizardForm; templateName: string; defaults: WizardDefaultsResponse | null; zone: ZoneState; onCheckZone: () => void; previewSrc: string | null; previewHtml?: string | null; live?: boolean; canEditTracking: boolean }) {
  const fromTemplate = "ใช้ค่าจากเทมเพลต";
  return (
    <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
      <h3>สรุป</h3>
      <div className="ledger" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
        <Row label="ชื่อแบรนด์" value={form.name} />
        <Row label="โดเมน" value={form.domain} />
        <Row label="คีย์เวิร์ด" value={form.keyword} />
        <Row label="เทมเพลต" value={templateName} />
        <Row label="โทรศัพท์" value={form.phone} />
        <Row label="อีเมล" value={form.email} />
        <Row label="ที่อยู่" value={form.address} />
        <Row label="ช่วงยอดเงิน" value={defaults ? defaults.amount_buckets.join(", ") : ""} />
        <Row label="เส้นทางฟอร์ม" value={defaults?.form_route ?? ""} />
        <Row label="ชื่อแบรนด์บนเว็บ" value={form.brand_name || fromTemplate} />
        <Row label="ชื่อหน้า" value={form.site_title || fromTemplate} />
        <Row label="คำอธิบาย" value={form.site_description || fromTemplate} />
        <Row label="H1" value={form.h1} />
        <Row label="CTA" value={form.cta} />
        <Row label="บัญชี Google Ads" value={form.google_ads_account} />
        <Row label="conversion action" value={form.google_conversion_action} />
        <Row label="โปรเจกต์ AdKit" value={form.adkit_project} />
      </div>
      {!canEditTracking && <p className="hint">Owner กำหนดค่าติดตามผล</p>}
      {!live && <>
        <h3>โซน Cloudflare</h3>
        <ZoneStatus zone={zone} />
        <div className="row"><button type="button" className="btn" onClick={onCheckZone} disabled={zone.state === "checking"}>ตรวจอีกครั้ง</button></div>
        {zoneBlocks(zone) && <p className="hint">สร้างไม่ได้จนกว่าโซนจะพร้อม</p>}
      </>}
      <h3>ตัวอย่างก่อนติดตั้ง</h3>
      {/* A live brand's preview is the POSTed render of unsaved edits; scripts are already removed and sandbox="" blocks the rest. */}
      {previewHtml !== null && <iframe style={{ width: "100%", height: 520, border: "1px solid var(--line)", borderRadius: 10, background: "var(--raised)" }} title="ตัวอย่างหน้าเว็บ" sandbox="" srcDoc={previewHtml} />}
      {previewSrc && <iframe key={previewSrc} style={{ width: "100%", height: 520, border: "1px solid var(--line)", borderRadius: 10, background: "var(--raised)" }} title="ตัวอย่างหน้าเว็บ" sandbox="" src={previewSrc} />}
    </div>
  );
}
