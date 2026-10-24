// spec settings: the controlled row drawer. Settings.tsx owns the draft so it can guard and reload it.
import { cleanKeyword, type BrandConfig } from "@anjuna/contracts";
import { useEffect, type ReactNode } from "react";
import { flowGateLabel } from "../labels";
import {
  KNOWN_FORMS,
  SETTINGS_LABELS,
  abOnDefaults,
  availableForms,
  buildPatch,
  formLabel,
  isDirty,
  parseDraft,
  type ArmDraft,
  type DraftErrors,
  type SettingsDraft,
} from "../settings-draft";

export type EditorBanner = { kind: "conflict" | "error"; text: string };

type Props = {
  brand: BrandConfig;
  draft: SettingsDraft;
  onDraft: (d: SettingsDraft) => void;
  onReview: () => void;
  onClose: () => void;
  banner: EditorBanner | null;
  saving: boolean;
};

const AB_ON = "เปิด A/B test (A/B test on)";
const knownForm = (id: string) => KNOWN_FORMS.some((f) => f.id === id);
const armTotal = (arms: ArmDraft[]) => arms.reduce((sum, a) => sum + (/^\s*\d+\s*$/.test(a.weight) ? Number(a.weight) : 0), 0);

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: (a: { id: string; "aria-label": string; "aria-invalid"?: true; "aria-describedby"?: string }) => ReactNode }) {
  const note = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="settings-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-label": label, "aria-invalid": error ? true : undefined, "aria-describedby": note })}
      {error && <div className="error small" id={`${id}-error`}>{error}</div>}
      {!error && hint && <div className="muted small" id={`${id}-hint`}>{hint}</div>}
    </div>
  );
}

export function SettingsEditor({ brand, draft, onDraft, onReview, onClose, banner, saving }: Props) {
  const domain = brand.hostnames[0] ?? brand.brand_id;
  const parsed = parseDraft(draft);
  const errors: DraftErrors = parsed.ok ? {} : parsed.errors;
  const canReview = isDirty(brand, draft) && buildPatch(brand, draft) !== null && !saving;
  const set = (patch: Partial<SettingsDraft>) => onDraft({ ...draft, ...patch });
  const setArm = (i: number, patch: Partial<ArmDraft>) => set({ arms: draft.arms.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  // A confirm dialog stops Escape before it reaches the document, so this never fires under one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleAb = (on: boolean) => {
    if (on && draft.arms.length === 0) set({ ab_on: true, ...abOnDefaults() });
    else set({ ab_on: on });
  };
  const unused = availableForms(draft.arms, draft.arms.length)[0];
  const typedKeyword = draft.keyword_default.trim();
  const cleanedKeyword = cleanKeyword(draft.keyword_default);
  const keywordHint = cleanedKeyword !== null && cleanedKeyword !== typedKeyword ? `จะบันทึกเป็น "${cleanedKeyword}" (Saved as "${cleanedKeyword}")` : undefined;
  const total = armTotal(draft.arms);

  return (
    <div className="drawer-wrap">
      <div className="scrim" onClick={onClose} />
      <aside className="drawer config-drawer settings-drawer" aria-label={`แก้ไขตั้งค่า ${domain} (Edit settings)`}>
        <header>
          <h2>{domain}</h2>
          <button type="button" className="link" onClick={onClose}>ปิด (Close)</button>
        </header>
        {banner && <div className={`note neg settings-banner settings-banner-${banner.kind}`} role="alert">{banner.text}</div>}

        <section className="section">
          <Field id="settings-aid" label={SETTINGS_LABELS.aid} error={errors.aid}>
            {(a) => <input {...a} value={draft.aid} onChange={(e) => set({ aid: e.target.value })} />}
          </Field>
          <Field id="settings-prepop" label={SETTINGS_LABELS.prepop_base} error={errors.prepop_base}>
            {(a) => <input {...a} value={draft.prepop_base} onChange={(e) => set({ prepop_base: e.target.value })} />}
          </Field>
          <Field id="settings-drain" label={SETTINGS_LABELS.drain_key} error={errors.drain_key}>
            {(a) => <input {...a} value={draft.drain_key} onChange={(e) => set({ drain_key: e.target.value })} />}
          </Field>
        </section>

        <section className="section">
          <Field id="settings-flow" label={SETTINGS_LABELS.flow_gate_mode} error={errors.flow_gate_mode}>
            {(a) => (
              <select {...a} value={draft.flow_gate_mode} onChange={(e) => set({ flow_gate_mode: e.target.value as SettingsDraft["flow_gate_mode"] })}>
                {(Object.keys(flowGateLabel) as (keyof typeof flowGateLabel)[]).map((mode) => <option key={mode} value={mode}>{flowGateLabel[mode]}</option>)}
              </select>
            )}
          </Field>
          <Field id="settings-buckets" label={SETTINGS_LABELS.amount_buckets} error={errors.amount_buckets}>
            {(a) => <input {...a} value={draft.amount_buckets} onChange={(e) => set({ amount_buckets: e.target.value })} />}
          </Field>
          <Field id="settings-keyword" label={SETTINGS_LABELS.keyword_default} error={errors.keyword_default} hint={keywordHint}>
            {(a) => <input {...a} value={draft.keyword_default} placeholder="ว่าง = ใช้ข้อความเริ่มต้นของ template" onChange={(e) => set({ keyword_default: e.target.value })} />}
          </Field>
        </section>

        <section className="section">
          <h3>{SETTINGS_LABELS.ab_config}</h3>
          <label className="row settings-switch">
            <input type="checkbox" role="switch" aria-label={AB_ON} checked={draft.ab_on} onChange={(e) => toggleAb(e.target.checked)} />
            {AB_ON}
          </label>
          {draft.ab_on && (
            <>
              <Field id="settings-experiment" label="Experiment id" error={errors.experiment_id}>
                {(a) => <input {...a} value={draft.experiment_id} onChange={(e) => set({ experiment_id: e.target.value })} />}
              </Field>
              {draft.arms.map((arm, i) => {
                const n = i + 1;
                return (
                  <div className="row settings-arm" key={i}>
                    {knownForm(arm.id)
                      ? (
                        <select aria-label={`ฟอร์มแขน ${n} (Arm ${n} form)`} value={arm.id} onChange={(e) => setArm(i, { id: e.target.value })}>
                          {availableForms(draft.arms, i).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                        </select>
                      )
                      : <span className="settings-arm-unknown">{formLabel(arm.id)}</span>}
                    <input
                      aria-label={`น้ำหนักแขน ${n} (Arm ${n} weight)`}
                      inputMode="numeric"
                      value={arm.weight}
                      onChange={(e) => setArm(i, { weight: e.target.value })}
                    />
                    {draft.arms.length > 2 && (
                      <button type="button" className="btn" aria-label={`ลบแขน ${n} (Remove arm ${n})`} onClick={() => set({ arms: draft.arms.filter((_, j) => j !== i) })}>ลบ (Remove)</button>
                    )}
                  </div>
                );
              })}
              {unused && (
                <button type="button" className="btn" onClick={() => set({ arms: [...draft.arms, { id: unused.id, weight: "0" }] })}>เพิ่มแขน (Add arm)</button>
              )}
              <div className={total === 100 ? "muted small" : "error"}>รวม {total}%</div>
              {errors.arms && <div className="error small">{errors.arms}</div>}
            </>
          )}
        </section>

        <button type="button" className="btn pri" disabled={!canReview} onClick={onReview}>ตรวจและบันทึก (Review and save)</button>
      </aside>
    </div>
  );
}
