// spec settings: draft, validation, patch and diff logic for the /settings editor. Pure; no React, no fetch.
import {
  AbConfig,
  AmountBuckets,
  DrainKey,
  ExperimentId,
  FlowGateMode,
  Keyword,
  LeadsGateAid,
  PrepopBase,
  cleanKeyword,
  type BrandConfig,
  type BrandPatchRequest,
} from "@anjuna/contracts";
import { flowGateLabel } from "./labels";

export const SETTINGS_FIELDS = ["aid", "ab_config", "flow_gate_mode", "amount_buckets", "keyword_default", "prepop_base", "drain_key"] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];

export const SETTINGS_LABELS: Record<SettingsField, string> = {
  aid: "AID (LeadsGate aid)",
  ab_config: "A/B test",
  flow_gate_mode: "เกต (Flow gate)",
  amount_buckets: "ช่วงยอดเงิน (Amount buckets)",
  keyword_default: "คีย์เวิร์ด (Keyword default)",
  prepop_base: "Prepop base",
  drain_key: "Drain key",
};

// The stored arm id is the form selector in the brand runtime; the label names the V1 form the owner knows.
export const KNOWN_FORMS = [
  { id: "lite_v1", label: "Lite (lite_v1)" },
  { id: "full_v1", label: "14 ขั้น (aurum-14-step)" },
] as const;

export function formLabel(armId: string): string {
  return KNOWN_FORMS.find((f) => f.id === armId)?.label ?? `ฟอร์มไม่รู้จัก, ใช้ Lite แทน (Unknown form, served as Lite) ${armId}`;
}

export type ArmDraft = { id: string; weight: string };
export type SettingsDraft = {
  aid: string;
  ab_on: boolean;
  experiment_id: string;
  arms: ArmDraft[];
  flow_gate_mode: FlowGateMode;
  amount_buckets: string;
  keyword_default: string;
  prepop_base: string;
  drain_key: string;
};
export type SettingsValues = Pick<BrandConfig, SettingsField>;
export type SettingsPatch = Partial<Pick<BrandPatchRequest, SettingsField>>;
export type DraftErrors = Partial<Record<SettingsField | "experiment_id" | "arms", string>>;

export function draftFromBrand(brand: BrandConfig): SettingsDraft {
  const ab = brand.ab_config;
  return {
    aid: brand.aid,
    ab_on: ab !== null,
    experiment_id: ab?.experiment_id ?? "",
    arms: ab?.variants.map((v) => ({ id: v.id, weight: String(v.weight) })) ?? [],
    flow_gate_mode: brand.flow_gate_mode,
    amount_buckets: brand.amount_buckets.join(", "),
    keyword_default: brand.keyword_default ?? "",
    prepop_base: brand.prepop_base,
    drain_key: brand.drain_key,
  };
}

export function abOnDefaults(): Pick<SettingsDraft, "experiment_id" | "arms"> {
  return { experiment_id: "", arms: [{ id: "lite_v1", weight: "50" }, { id: "full_v1", weight: "50" }] };
}

export function availableForms(arms: ArmDraft[], index: number): (typeof KNOWN_FORMS)[number][] {
  const others = new Set(arms.filter((_, i) => i !== index).map((a) => a.id));
  const own = arms[index]?.id;
  return KNOWN_FORMS.filter((f) => f.id === own || !others.has(f.id));
}

const DIGITS_RE = /^\d+$/;
const BUCKET_DIGITS_MESSAGE = "ใส่ตัวเลขจำนวนเต็มคั่นด้วยจุลภาค (Whole numbers separated by commas)";
const firstMessage = (issues: { message: string }[]) => issues[0]?.message ?? "Invalid";
const bucketTokens = (text: string) => text.split(",").map((s) => s.trim());

export function parseDraft(d: SettingsDraft): { ok: true; values: SettingsValues } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const check = <T>(field: SettingsField, r: { success: true; data: T } | { success: false; error: { issues: { message: string }[] } }): T | undefined => {
    if (r.success) return r.data;
    errors[field] = firstMessage(r.error.issues);
    return undefined;
  };

  const aid = check("aid", LeadsGateAid.safeParse(d.aid.trim()));
  const flow_gate_mode = check("flow_gate_mode", FlowGateMode.safeParse(d.flow_gate_mode));
  const tokens = bucketTokens(d.amount_buckets);
  let amount_buckets: number[] | undefined;
  if (tokens.every((t) => DIGITS_RE.test(t))) amount_buckets = check("amount_buckets", AmountBuckets.safeParse(tokens.map(Number)));
  else errors.amount_buckets = BUCKET_DIGITS_MESSAGE;
  const cleaned = cleanKeyword(d.keyword_default);
  const keyword_default = cleaned === null ? null : check("keyword_default", Keyword.safeParse(cleaned));
  const prepop_base = check("prepop_base", PrepopBase.safeParse(d.prepop_base.trim()));
  const drain_key = check("drain_key", DrainKey.safeParse(d.drain_key.trim()));

  let ab_config: AbConfig | null | undefined = null;
  if (d.ab_on) {
    ab_config = undefined;
    const experiment_id = d.experiment_id.trim();
    const id = ExperimentId.safeParse(experiment_id);
    if (experiment_id === "") errors.experiment_id = "ต้องใส่ Experiment id (Required)";
    else if (!id.success) errors.experiment_id = "รหัส experiment ใช้ได้เฉพาะ A-Z a-z 0-9 _ - ไม่เกิน 64 ตัว (Letters, digits, _ and -, up to 64)";

    const arms = d.arms.map((a) => ({ id: a.id.trim(), weight: a.weight.trim() }));
    if (arms.length < 2) errors.arms = "ต้องมีอย่างน้อย 2 แขน (At least 2 arms)";
    else if (arms.some((a) => !DIGITS_RE.test(a.weight) || Number(a.weight) > 100)) errors.arms = "น้ำหนักต้องเป็นจำนวนเต็ม 0 ถึง 100 (Weights must be whole numbers from 0 to 100)";
    else if (new Set(arms.map((a) => a.id)).size !== arms.length) errors.arms = "ห้ามใช้ฟอร์มซ้ำ (Each arm needs its own form)";
    else {
      const sum = arms.reduce((s, a) => s + Number(a.weight), 0);
      if (sum !== 100) errors.arms = `รวม ${sum}% ต้องเป็น 100% (Weights must sum to 100)`;
    }

    if (!errors.experiment_id && !errors.arms) {
      const r = AbConfig.safeParse({ experiment_id, variants: arms.map((a) => ({ id: a.id, weight: Number(a.weight) })) });
      if (r.success) ab_config = r.data;
      else errors.arms = firstMessage(r.error.issues);
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    values: {
      aid: aid!,
      ab_config: ab_config!,
      flow_gate_mode: flow_gate_mode!,
      amount_buckets: amount_buckets!,
      keyword_default: keyword_default!,
      prepop_base: prepop_base!,
      drain_key: drain_key!,
    },
  };
}

// Whitespace and number formatting never count as an edit: "1000 ,2000" equals "1000, 2000" and " 123 " equals "123".
function normalise(d: SettingsDraft): string {
  const numeric = (s: string, re: RegExp) => (re.test(s) ? String(Number(s)) : s);
  return JSON.stringify({
    aid: d.aid.trim(),
    ab: d.ab_on ? { id: d.experiment_id.trim(), arms: d.arms.map((a) => [a.id.trim(), numeric(a.weight.trim(), DIGITS_RE)]) } : null,
    flow: d.flow_gate_mode,
    buckets: bucketTokens(d.amount_buckets).map((t) => (DIGITS_RE.test(t) ? String(Number(t)) : t)),
    keyword: cleanKeyword(d.keyword_default) ?? "",
    prepop: d.prepop_base.trim(),
    drain: d.drain_key.trim(),
  });
}

export function isDirty(brand: BrandConfig, d: SettingsDraft): boolean {
  return normalise(d) !== normalise(draftFromBrand(brand));
}

const canon = (field: SettingsField, value: unknown): string =>
  JSON.stringify(field === "ab_config" && value !== null ? { experiment_id: (value as AbConfig).experiment_id, variants: (value as AbConfig).variants.map((v) => ({ id: v.id, weight: v.weight })) } : value);

export function buildPatch(brand: BrandConfig, d: SettingsDraft): SettingsPatch | null {
  const parsed = parseDraft(d);
  if (!parsed.ok) return null;
  const patch: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) {
    if (canon(field, parsed.values[field]) !== canon(field, brand[field])) patch[field] = parsed.values[field];
  }
  return patch as SettingsPatch;
}

export function formatSetting(field: SettingsField, value: SettingsValues[SettingsField]): string {
  switch (field) {
    case "ab_config": {
      const ab = value as AbConfig | null;
      return ab === null ? "ปิด (Off)" : `${ab.experiment_id}: ${ab.variants.map((v) => `${formLabel(v.id)} ${v.weight}%`).join(" / ")}`;
    }
    case "flow_gate_mode":
      return flowGateLabel[value as FlowGateMode];
    case "amount_buckets":
      return (value as number[]).join(", ");
    case "keyword_default":
      return value === null ? "—" : String(value);
    default:
      return String(value);
  }
}

export function diffRows(brand: BrandConfig, patch: SettingsPatch): { field: SettingsField; label: string; before: string; after: string }[] {
  return SETTINGS_FIELDS.filter((f) => Object.hasOwn(patch, f)).map((field) => ({
    field,
    label: SETTINGS_LABELS[field],
    before: formatSetting(field, brand[field]),
    after: formatSetting(field, patch[field] as SettingsValues[SettingsField]),
  }));
}

export function redrawsVisitors(brand: BrandConfig, patch: SettingsPatch): boolean {
  if (!Object.hasOwn(patch, "ab_config")) return false;
  const before = brand.ab_config;
  const after = patch.ab_config ?? null;
  return (before === null) !== (after === null) || before?.experiment_id !== after?.experiment_id;
}

export function touchesMoney(patch: SettingsPatch): boolean {
  return Object.hasOwn(patch, "aid") || Object.hasOwn(patch, "prepop_base") || Object.hasOwn(patch, "drain_key");
}
