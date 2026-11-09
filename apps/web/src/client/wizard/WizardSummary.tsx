import { Check } from "lucide-react";
import type { WizardForm } from "./steps";

/**
 * The summary column of the wizard (design WizardSummary): what the form holds now, one row per part, filled from the form state.
 * A row with a value shows a check; an empty one shows its blank. It lists no API calls.
 */
export function WizardSummary({ form, templateName, customTheme, drafted }: { form: WizardForm; templateName: string; customTheme: boolean; drafted: boolean }) {
  const copyFilled = [form.brand_name, form.site_title, form.site_description, form.h1, form.cta, form.sub].some((value) => value.trim() !== "");
  const rows: Array<{ id: string; label: string; value: string }> = [
    { id: "name", label: "ชื่อแบรนด์", value: form.name.trim() },
    { id: "domain", label: "โดเมน", value: form.domain.trim() },
    { id: "template", label: "เทมเพลต", value: templateName },
    { id: "colors", label: "สี", value: templateName ? (customTheme ? "เลือกเอง" : "ใช้สีของเทมเพลต") : "" },
    { id: "copy", label: "ข้อความ", value: copyFilled ? "กรอกแล้ว" : "ใช้ค่าจากเทมเพลต" },
    { id: "ads", label: "บัญชี Google Ads", value: form.google_ads_account.trim() ? "เลือกแล้ว" : "" },
    { id: "conversion", label: "conversion action", value: form.google_conversion_action.trim() ? "ตั้งแล้ว" : "" },
  ];
  return (
    <aside className="wizard-summary panel" aria-label="สรุปแบรนด์">
      <h2>สรุป</h2>
      <ul>
        {rows.map((row) => (
          <li key={row.id} data-filled={row.value !== "" ? "true" : "false"}>
            <span className="wizard-summary-mark" aria-hidden="true">{row.value !== "" && <Check size={14} />}</span>
            <span className="wizard-summary-label">{row.label}</span>
            <b className="wizard-summary-value">{row.value || "—"}</b>
          </li>
        ))}
      </ul>
      <p className="hint">{drafted ? "ร่างบันทึกไว้แล้ว กดถัดไปเพื่อบันทึกการแก้ไข" : "ร่างจะถูกสร้างเมื่อกดถัดไปครั้งแรก"}</p>
    </aside>
  );
}
