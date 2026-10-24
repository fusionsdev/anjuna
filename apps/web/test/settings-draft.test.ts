import { describe, expect, it } from "vitest";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { BrandConfig } from "@anjuna/contracts";
import {
  abOnDefaults,
  availableForms,
  buildPatch,
  diffRows,
  draftFromBrand,
  formLabel,
  isDirty,
  parseDraft,
  redrawsVisitors,
  touchesMoney,
  type SettingsDraft,
} from "../src/client/settings-draft";

const make = (over: Record<string, unknown> = {}) => BrandConfig.parse({ ...brandFixture.brand, ...over });
const arms = (...a: [string, number][]) => ({ experiment_id: "exp-1", variants: a.map(([id, weight]) => ({ id, weight })) });
const edit = (b: BrandConfig, over: Partial<SettingsDraft>): SettingsDraft => ({ ...draftFromBrand(b), ...over });

describe("settings draft", () => {
  it("draftFromBrand then buildPatch on an untouched draft returns {}", () => {
    for (const b of [make(), make({ ab_config: null, keyword_default: null }), make({ ab_config: arms(["lite_v1", 60], ["full_v1", 40]) })]) {
      const d = draftFromBrand(b);
      expect(buildPatch(b, d)).toEqual({});
      expect(isDirty(b, d)).toBe(false);
    }
    const d = draftFromBrand(make({ keyword_default: null }));
    expect(d.keyword_default).toBe("");
    expect(d.amount_buckets).toBe("500, 1000, 1500, 2500");
    expect(d.ab_on).toBe(true);
  });

  it("whitespace-only edits are not dirty", () => {
    const b = make({ amount_buckets: [1000, 2000], keyword_default: "Loans" });
    const d = edit(b, { aid: ` ${b.aid} `, amount_buckets: "1000 ,2000", keyword_default: " Loans ", drain_key: ` ${b.drain_key}`, prepop_base: `${b.prepop_base} ` });
    expect(isDirty(b, d)).toBe(false);
    expect(buildPatch(b, d)).toEqual({});
    expect(isDirty(b, edit(b, { amount_buckets: "1000, 2000" }))).toBe(false);
    expect(isDirty(b, edit(b, { amount_buckets: "1000,2000" }))).toBe(false);
  });

  it("buildPatch holds only changed fields", () => {
    const b = make();
    const patch = buildPatch(b, edit(b, { drain_key: "dk_new", flow_gate_mode: "signed_cookie" }));
    expect(patch).toEqual({ drain_key: "dk_new", flow_gate_mode: "signed_cookie" });
    expect(Object.keys(patch!).sort()).toEqual(["drain_key", "flow_gate_mode"]);
  });

  it("empty keyword becomes null", () => {
    const b = make({ keyword_default: "Loans" });
    expect(buildPatch(b, edit(b, { keyword_default: "" }))).toEqual({ keyword_default: null });
    expect(buildPatch(b, edit(b, { keyword_default: "   " }))).toEqual({ keyword_default: null });
  });

  it("turning A/B off patches ab_config null", () => {
    const b = make();
    const d = edit(b, { ab_on: false });
    expect(isDirty(b, d)).toBe(true);
    expect(buildPatch(b, d)).toEqual({ ab_config: null });
  });

  it("turning A/B on with abOnDefaults and experiment id \"exp-1\" patches lite_v1 50 / full_v1 50", () => {
    const b = make({ ab_config: null });
    const d = edit(b, { ab_on: true, ...abOnDefaults(), experiment_id: "exp-1" });
    expect(buildPatch(b, d)).toEqual({ ab_config: arms(["lite_v1", 50], ["full_v1", 50]) });
    expect(abOnDefaults()).toEqual({ experiment_id: "", arms: [{ id: "lite_v1", weight: "50" }, { id: "full_v1", weight: "50" }] });
  });

  it("weights that do not sum to 100 fail with errors.arms and buildPatch returns null", () => {
    const b = make({ ab_config: arms(["lite_v1", 50], ["full_v1", 50]) });
    const d = edit(b, { arms: [{ id: "lite_v1", weight: "60" }, { id: "full_v1", weight: "30" }] });
    const r = parseDraft(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.arms).toBe("รวม 90% ต้องเป็น 100% (Weights must sum to 100)");
    expect(buildPatch(b, d)).toBeNull();
    expect(isDirty(b, d)).toBe(true);
  });

  it("a duplicate arm id fails", () => {
    const b = make({ ab_config: arms(["lite_v1", 50], ["full_v1", 50]) });
    const d = edit(b, { arms: [{ id: "lite_v1", weight: "50" }, { id: "lite_v1", weight: "50" }] });
    const r = parseDraft(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.arms).toBe("ห้ามใช้ฟอร์มซ้ำ (Each arm needs its own form)");
    expect(buildPatch(b, edit(b, { arms: [{ id: "lite_v1", weight: "100" }] }))).toBeNull();
  });

  it("a non-integer weight \"33.5\" fails", () => {
    const b = make({ ab_config: arms(["lite_v1", 50], ["full_v1", 50]) });
    const r = parseDraft(edit(b, { arms: [{ id: "lite_v1", weight: "33.5" }, { id: "full_v1", weight: "66.5" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.arms).toBe("น้ำหนักต้องเป็นจำนวนเต็ม 0 ถึง 100 (Weights must be whole numbers from 0 to 100)");
    const neg = parseDraft(edit(b, { arms: [{ id: "lite_v1", weight: "-10" }, { id: "full_v1", weight: "110" }] }));
    expect(neg.ok).toBe(false);
  });

  it("an empty experiment id with A/B on fails with errors.experiment_id", () => {
    const b = make({ ab_config: null });
    const r = parseDraft(edit(b, { ab_on: true, ...abOnDefaults() }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.experiment_id).toBe("ต้องใส่ Experiment id (Required)");
  });

  it("an experiment id with a bad character gets the Thai-first pattern message", () => {
    const b = make({ ab_config: null });
    const r = parseDraft(edit(b, { ab_on: true, ...abOnDefaults(), experiment_id: "exp 1!" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.experiment_id).toBe("รหัส experiment ใช้ได้เฉพาะ A-Z a-z 0-9 _ - ไม่เกิน 64 ตัว (Letters, digits, _ and -, up to 64)");
  });

  it("bucket tokens that are not plain digits fail", () => {
    const b = make();
    for (const bad of ["0x1F4, 1000", "1e3, 2000", "-5, 1000", "500, 1e3"]) {
      const r = parseDraft(edit(b, { amount_buckets: bad }));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(["amount_buckets"]);
    }
  });

  it("a bucket token that is not plain digits gives the whole-number message; order failures keep the contract message", () => {
    const b = make();
    for (const bad of ["abc", "1000,", "10.5", "", "500, 1e3"]) {
      const r = parseDraft(edit(b, { amount_buckets: bad }));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors.amount_buckets).toBe("ใส่ตัวเลขจำนวนเต็มคั่นด้วยจุลภาค (Whole numbers separated by commas)");
    }
    const order = parseDraft(edit(b, { amount_buckets: "1000, 500" }));
    expect(order.ok).toBe(false);
    if (!order.ok) expect(order.errors.amount_buckets).toBe("Amount buckets must be unique and ascending");
  });

  it("keyword default goes through cleanKeyword before validation", () => {
    const b = make({ keyword_default: "Loans" });
    const parsed = (keyword_default: string) => {
      const r = parseDraft(edit(b, { keyword_default }));
      return r.ok ? r.values.keyword_default : "invalid";
    };
    expect(parsed("loans")).toBe("Loans");
    expect(parsed("  personal   loans ")).toBe("Personal Loans");
    expect(parsed("!!! ###")).toBeNull();
    expect(isDirty(b, edit(b, { keyword_default: "loans" }))).toBe(false);
    expect(buildPatch(b, edit(b, { keyword_default: "loans" }))).toEqual({});
    expect(isDirty(b, edit(b, { keyword_default: "personal loans" }))).toBe(true);
    expect(buildPatch(b, edit(b, { keyword_default: "personal loans" }))).toEqual({ keyword_default: "Personal Loans" });
    expect(buildPatch(b, edit(b, { keyword_default: "!!!" }))).toEqual({ keyword_default: null });
  });

  it("invalid aid, prepop base, drain key and buckets each give their own error key", () => {
    const b = make();
    const r = parseDraft(edit(b, { aid: "bad aid", prepop_base: "http://insecure.example", drain_key: "bad key!", amount_buckets: "1000, 500" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(["aid", "amount_buckets", "drain_key", "prepop_base"]);
      expect(r.errors.aid).toBe("Invalid aid");
      expect(r.errors.drain_key).toBe("Invalid drain_key");
    }
    for (const bad of ["", "abc", "1000,", "10.5"]) {
      expect(parseDraft(edit(b, { amount_buckets: bad })).ok).toBe(false);
    }
    expect(parseDraft(edit(b, { aid: "" })).ok).toBe(false);
  });

  it("an unknown arm id survives draftFromBrand and buildPatch unchanged", () => {
    const b = make({ ab_config: arms(["promo_v2", 60], ["lite_v1", 40]) });
    const d = draftFromBrand(b);
    expect(d.arms).toEqual([{ id: "promo_v2", weight: "60" }, { id: "lite_v1", weight: "40" }]);
    expect(isDirty(b, d)).toBe(false);
    expect(buildPatch(b, d)).toEqual({});
    expect(formLabel("promo_v2")).toBe("ฟอร์มไม่รู้จัก, ใช้ Lite แทน (Unknown form, served as Lite) promo_v2");
    expect(formLabel("lite_v1")).toBe("Lite (lite_v1)");
    expect(formLabel("full_v1")).toBe("14 ขั้น (aurum-14-step)");
    const changed = edit(b, { arms: [{ id: "promo_v2", weight: "70" }, { id: "lite_v1", weight: "30" }] });
    expect(buildPatch(b, changed)).toEqual({ ab_config: arms(["promo_v2", 70], ["lite_v1", 30]) });
  });

  it("availableForms hides a form another arm uses", () => {
    const a = [{ id: "lite_v1", weight: "50" }, { id: "full_v1", weight: "50" }];
    expect(availableForms(a, 0).map((f) => f.id)).toEqual(["lite_v1"]);
    expect(availableForms(a, 1).map((f) => f.id)).toEqual(["full_v1"]);
    const dup = [{ id: "lite_v1", weight: "50" }, { id: "lite_v1", weight: "50" }];
    expect(availableForms(dup, 0).map((f) => f.id)).toContain("lite_v1");
    expect(availableForms([{ id: "promo_v2", weight: "50" }, { id: "x", weight: "50" }], 0).map((f) => f.id)).toEqual(["lite_v1", "full_v1"]);
    expect(availableForms([{ id: "promo_v2", weight: "50" }, { id: "lite_v1", weight: "50" }], 0).map((f) => f.id)).toEqual(["full_v1"]);
  });

  it("diffRows renders before and after with flowGateLabel and Off", () => {
    const b = make({ ab_config: arms(["lite_v1", 60], ["full_v1", 40]), keyword_default: null });
    const rows = diffRows(b, {
      keyword_default: "Loans",
      flow_gate_mode: "signed_cookie",
      ab_config: null,
      amount_buckets: [1000, 2000],
    });
    expect(rows).toEqual([
      { field: "ab_config", label: "A/B test", before: "exp-1: Lite (lite_v1) 60% / 14 ขั้น (aurum-14-step) 40%", after: "ปิด (Off)" },
      { field: "flow_gate_mode", label: "เกต (Flow gate)", before: "Keyword Param", after: "Single Page Cookie" },
      { field: "amount_buckets", label: "ช่วงยอดเงิน (Amount buckets)", before: "500, 1000, 1500, 2500", after: "1000, 2000" },
      { field: "keyword_default", label: "คีย์เวิร์ด (Keyword default)", before: "—", after: "Loans" },
    ]);
    expect(diffRows(b, { aid: "999" })).toEqual([{ field: "aid", label: "AID (LeadsGate aid)", before: "10001", after: "999" }]);
    expect(diffRows(b, {})).toEqual([]);
  });

  it("redrawsVisitors is true for a new experiment id and for on/off, false for a weights-only change", () => {
    const on = make({ ab_config: arms(["lite_v1", 50], ["full_v1", 50]) });
    const off = make({ ab_config: null });
    expect(redrawsVisitors(on, { ab_config: { ...arms(["lite_v1", 50], ["full_v1", 50]), experiment_id: "exp-2" } })).toBe(true);
    expect(redrawsVisitors(on, { ab_config: null })).toBe(true);
    expect(redrawsVisitors(off, { ab_config: arms(["lite_v1", 50], ["full_v1", 50]) })).toBe(true);
    expect(redrawsVisitors(on, { ab_config: arms(["lite_v1", 70], ["full_v1", 30]) })).toBe(false);
    expect(redrawsVisitors(on, { aid: "999" })).toBe(false);
  });

  it("touchesMoney is true only for aid, prepop_base and drain_key", () => {
    expect(touchesMoney({ aid: "1" })).toBe(true);
    expect(touchesMoney({ prepop_base: "/apply" })).toBe(true);
    expect(touchesMoney({ drain_key: "k" })).toBe(true);
    expect(touchesMoney({ ab_config: null })).toBe(false);
    expect(touchesMoney({ flow_gate_mode: "param" })).toBe(false);
    expect(touchesMoney({ amount_buckets: [1000] })).toBe(false);
    expect(touchesMoney({ keyword_default: null })).toBe(false);
    expect(touchesMoney({})).toBe(false);
  });
});
