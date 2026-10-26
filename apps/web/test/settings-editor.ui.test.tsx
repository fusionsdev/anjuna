import { BrandConfig } from "@anjuna/contracts";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsEditor } from "../src/client/screens/SettingsEditor";
import { draftFromBrand, formLabel, type SettingsDraft } from "../src/client/settings-draft";

const brand = (over: Record<string, unknown> = {}) => BrandConfig.parse({ ...brandFixture.brand, hostnames: ["alpha.example.test"], ...over });
const arms = (...a: [string, number][]) => ({ experiment_id: "exp-1", variants: a.map(([id, weight]) => ({ id, weight })) });

type Banner = { kind: "conflict" | "error"; text: string } | null;
const Harness = ({ b, onClose = () => {}, onReview = () => {}, banner = null, saving = false, seed }: {
  b: BrandConfig; onClose?: () => void; onReview?: () => void; banner?: Banner; saving?: boolean; seed?: (d: SettingsDraft) => SettingsDraft;
}) => {
  const [draft, setDraft] = useState(() => (seed ? seed(draftFromBrand(b)) : draftFromBrand(b)));
  return <SettingsEditor brand={b} draft={draft} onDraft={setDraft} onReview={onReview} onClose={onClose} banner={banner} saving={saving} />;
};

afterEach(cleanup);

const review = () => screen.getByRole("button", { name: "ตรวจและบันทึก (Review and save)" }) as HTMLButtonElement;
// Selects and inputs both expose .value; the select typing from this DOM lib does not satisfy HTMLElement.
const valueOf = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("SettingsEditor", () => {
  it("Review and save is disabled until a field changes", () => {
    const onReview = vi.fn();
    render(<Harness b={brand()} onReview={onReview} />);
    expect(screen.getByRole("complementary", { name: "แก้ไขตั้งค่า alpha.example.test (Edit settings)" })).toBeTruthy();
    expect(review().disabled).toBe(true);
    type("Drain key", "dk_changed");
    expect(review().disabled).toBe(false);
    fireEvent.click(review());
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("settings shows the stored theme", () => {
    render(<Harness b={brand({ theme: { primary: "#0f766e", secondary: "#1e293b" } })} />);
    expect(valueOf("รหัสสีหลัก (Primary hex)")).toBe("#0f766e");
    expect(valueOf("รหัสสีรอง (Secondary hex)")).toBe("#1e293b");
    expect(valueOf("สีหลัก (Primary)")).toBe("#0f766e");
    expect(valueOf("สีรอง (Secondary)")).toBe("#1e293b");
  });

  it("settings shows template defaults for a null theme", () => {
    render(<Harness b={brand({ theme: null })} />);
    expect(valueOf("สีหลัก (Primary)")).toBe("#2563eb");
    expect(valueOf("สีรอง (Secondary)")).toBe("#1e293b");
  });

  it("an invalid drain key shows its error, sets aria-invalid and disables Review and save", () => {
    render(<Harness b={brand()} />);
    type("Drain key", "bad key!");
    const input = screen.getByLabelText("Drain key");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Drain key ใช้ได้เฉพาะ A-Z a-z 0-9 _ - ไม่เกิน 64 ตัว (Invalid drain key)")).toBeTruthy();
    expect(review().disabled).toBe(true);
    expect(screen.getByLabelText("AID (LeadsGate aid)").getAttribute("aria-invalid")).toBeNull();
  });

  it("a bucket that is not a whole number shows the whole-number message", () => {
    render(<Harness b={brand()} />);
    type("ช่วงยอดเงิน (Amount buckets)", "abc");
    expect(screen.getByText("ใส่ตัวเลขจำนวนเต็มคั่นด้วยจุลภาค (Whole numbers separated by commas)")).toBeTruthy();
    expect(review().disabled).toBe(true);
  });

  it("the flow gate select offers Keyword Param and Single Page Cookie", () => {
    render(<Harness b={brand({ flow_gate_mode: "param" })} />);
    const select = screen.getByLabelText("เกต (Flow gate)");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Keyword Param", "Single Page Cookie"]);
    fireEvent.change(select, { target: { value: "signed_cookie" } });
    expect(valueOf("เกต (Flow gate)")).toBe("signed_cookie");
    expect(review().disabled).toBe(false);
  });

  it("the keyword hint shows the cleaned value only when it differs from the typed text", () => {
    render(<Harness b={brand({ keyword_default: null })} />);
    expect(screen.queryByText(/จะบันทึกเป็น/)).toBeNull();
    type("คีย์เวิร์ด (Keyword default)", "personal  loans");
    expect(screen.getByText('จะบันทึกเป็น "Personal Loans" (Saved as "Personal Loans")')).toBeTruthy();
    type("คีย์เวิร์ด (Keyword default)", "Personal Loans ");
    expect(screen.queryByText(/จะบันทึกเป็น/)).toBeNull();
    type("คีย์เวิร์ด (Keyword default)", "");
    expect(screen.queryByText(/จะบันทึกเป็น/)).toBeNull();
    type("คีย์เวิร์ด (Keyword default)", "   ");
    expect(screen.queryByText(/จะบันทึกเป็น/)).toBeNull();
  });

  it("a keyword that cleans to nothing says it is saved as the template default", () => {
    render(<Harness b={brand({ keyword_default: "Loans" })} />);
    type("คีย์เวิร์ด (Keyword default)", "!!!");
    expect(screen.getByText("จะบันทึกเป็นค่าเริ่มต้นของ template (Saved as the template default)")).toBeTruthy();
    expect(review().disabled).toBe(false);
  });

  it("turning A/B on shows two arms lite_v1 50 and full_v1 50 and requires an experiment id", () => {
    render(<Harness b={brand({ ab_config: null })} />);
    expect(screen.queryByLabelText("รหัส Experiment (Experiment id)")).toBeNull();
    fireEvent.click(screen.getByLabelText("เปิด A/B test (A/B test on)"));
    expect(valueOf("ฟอร์มแขน 1 (Arm 1 form)")).toBe("lite_v1");
    expect(valueOf("ฟอร์มแขน 2 (Arm 2 form)")).toBe("full_v1");
    expect((screen.getByLabelText("น้ำหนักแขน 1 (Arm 1 weight)") as HTMLInputElement).value).toBe("50");
    expect((screen.getByLabelText("น้ำหนักแขน 2 (Arm 2 weight)") as HTMLInputElement).value).toBe("50");
    expect(screen.getByLabelText("รหัส Experiment (Experiment id)").getAttribute("aria-invalid")).toBe("true");
    expect(review().disabled).toBe(true);
    type("รหัส Experiment (Experiment id)", "exp-2");
    expect(review().disabled).toBe(false);
  });

  it("the arm form select offers only forms no other arm uses", () => {
    render(<Harness b={brand({ ab_config: arms(["lite_v1", 50], ["full_v1", 50]) })} />);
    for (const n of [1, 2]) {
      const select = screen.getByLabelText(`ฟอร์มแขน ${n} (Arm ${n} form)`);
      expect(within(select).getAllByRole("option")).toHaveLength(1);
    }
    expect(within(screen.getByLabelText("ฟอร์มแขน 1 (Arm 1 form)")).getByRole("option").textContent).toBe("Lite (lite_v1)");
    expect(within(screen.getByLabelText("ฟอร์มแขน 2 (Arm 2 form)")).getByRole("option").textContent).toBe("14 ขั้น (aurum-14-step)");
    expect(screen.queryByRole("button", { name: /เพิ่มแขน/ })).toBeNull();
  });

  it("Add arm appears while a known form is unused and adds it with weight 0", () => {
    render(<Harness b={brand({ ab_config: arms(["promo_v2", 60], ["lite_v1", 40]) })} />);
    fireEvent.click(screen.getByRole("button", { name: "เพิ่มแขน (Add arm)" }));
    expect(valueOf("ฟอร์มแขน 3 (Arm 3 form)")).toBe("full_v1");
    expect((screen.getByLabelText("น้ำหนักแขน 3 (Arm 3 weight)") as HTMLInputElement).value).toBe("0");
    expect(screen.queryByRole("button", { name: "เพิ่มแขน (Add arm)" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /ลบ/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "ลบแขน 3 (Remove arm 3)" }));
    expect(screen.queryByLabelText("ฟอร์มแขน 3 (Arm 3 form)")).toBeNull();
  });

  it("weights 60 and 30 show \"รวม 90%\" as an error and disable Review and save", () => {
    render(<Harness b={brand({ ab_config: arms(["lite_v1", 50], ["full_v1", 50]) })} />);
    type("น้ำหนักแขน 1 (Arm 1 weight)", "60");
    type("น้ำหนักแขน 2 (Arm 2 weight)", "30");
    const total = screen.getByText("รวม 90%");
    expect(total.className).toContain("error");
    // The sum message is the total line itself, not a second line.
    expect(screen.queryByText(/ต้องเป็น 100%/)).toBeNull();
    for (const n of [1, 2]) {
      const weight = screen.getByLabelText(`น้ำหนักแขน ${n} (Arm ${n} weight)`);
      expect(weight.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById(weight.getAttribute("aria-describedby")!)).toBe(total);
    }
    expect(review().disabled).toBe(true);
    type("น้ำหนักแขน 2 (Arm 2 weight)", "40");
    expect(screen.getByText("รวม 100%").className).not.toContain("error");
    for (const n of [1, 2]) {
      const weight = screen.getByLabelText(`น้ำหนักแขน ${n} (Arm ${n} weight)`);
      expect(weight.getAttribute("aria-invalid")).toBeNull();
      expect(weight.getAttribute("aria-describedby")).toBeNull();
    }
    expect(review().disabled).toBe(false);
  });

  it("other arm errors still show their own message and mark the weights", () => {
    render(<Harness b={brand({ ab_config: arms(["lite_v1", 50], ["full_v1", 50]) })} />);
    type("น้ำหนักแขน 1 (Arm 1 weight)", "33.5");
    const message = screen.getByText("น้ำหนักต้องเป็นจำนวนเต็ม 0 ถึง 100 (Weights must be whole numbers from 0 to 100)");
    const weight = screen.getByLabelText("น้ำหนักแขน 2 (Arm 2 weight)");
    expect(weight.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(weight.getAttribute("aria-describedby")!)).toBe(message);
    expect(review().disabled).toBe(true);
  });

  it("the keyword placeholder carries the English gloss", () => {
    render(<Harness b={brand()} />);
    expect(screen.getByLabelText("คีย์เวิร์ด (Keyword default)").getAttribute("placeholder")).toBe("ว่าง = ใช้ข้อความเริ่มต้นของ template (Empty = template default)");
  });

  it("Remove is hidden at two arms", () => {
    render(<Harness b={brand({ ab_config: arms(["lite_v1", 50], ["full_v1", 50]) })} />);
    expect(screen.queryByRole("button", { name: /ลบ/ })).toBeNull();
  });

  it("an unknown arm id shows its label as text and its weight stays editable", () => {
    render(<Harness b={brand({ ab_config: arms(["promo_v2", 60], ["lite_v1", 40]) })} />);
    expect(screen.getByText(formLabel("promo_v2"))).toBeTruthy();
    expect(screen.queryByLabelText("ฟอร์มแขน 1 (Arm 1 form)")).toBeNull();
    expect(review().disabled).toBe(true);
    type("น้ำหนักแขน 1 (Arm 1 weight)", "70");
    type("น้ำหนักแขน 2 (Arm 2 weight)", "30");
    expect(review().disabled).toBe(false);
    expect(screen.queryAllByRole("button", { name: /ลบ/ })).toHaveLength(0);
  });

  it("Close, the scrim and Escape call onClose", () => {
    const onClose = vi.fn();
    const { container } = render(<Harness b={brand()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    fireEvent.click(container.querySelector(".scrim")!);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("Escape does not close the drawer while a confirm dialog handles it", () => {
    const onClose = vi.fn();
    render(
      <div>
        <Harness b={brand()} onClose={onClose} />
        <div role="presentation" onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation(); }}>
          <input aria-label="inside dialog" />
        </div>
      </div>,
    );
    fireEvent.keyDown(screen.getByLabelText("inside dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the banner renders with role alert", () => {
    render(<Harness b={brand()} banner={{ kind: "conflict", text: "มีคนแก้ไขแบรนด์นี้" }} />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toBe("มีคนแก้ไขแบรนด์นี้");
    // .note from styles.css wins the cascade over a class rule, so red comes from the inline style.
    expect(banner.className).toContain("settings-banner");
    expect(banner.getAttribute("style")).toContain("background: var(--badbg)");
    expect(banner.getAttribute("style")).toContain("color: var(--bad)");
  });

  it("while saving the inputs are disabled and Close, the scrim and Escape do nothing", () => {
    const onClose = vi.fn();
    const { container } = render(<Harness b={brand()} onClose={onClose} saving seed={(d) => ({ ...d, drain_key: "dk_changed" })} />);
    for (const el of screen.getAllByRole("textbox")) expect((el as HTMLInputElement).disabled || el.closest("fieldset")?.disabled).toBeTruthy();
    expect(screen.getByRole("switch").closest("fieldset")!.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "ปิด (Close)" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    fireEvent.click(container.querySelector(".scrim")!);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Review and save stays disabled while saving", () => {
    render(<Harness b={brand()} saving seed={(d) => ({ ...d, drain_key: "dk_changed" })} />);
    expect(review().disabled).toBe(true);
  });
});
