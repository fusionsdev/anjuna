/** Duplicate a brand: a new domain is required, a name is optional. The copy is a draft the wizard then opens. */
import { BrandName } from "@anjuna/contracts";
import { useState } from "react";
import { DraftDomain } from "../../shared/wizard";
import { api } from "../api";
import { describeIssue, requiredText, wizardErrorText } from "./messages";

export function DuplicateDialog({ source, onClose, onDuplicated }: { source: { brand_id: string; name?: string }; onClose: () => void; onDuplicated: (brandId: string) => void }) {
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<{ domain?: string; name?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const found: { domain?: string; name?: string } = {};
    const parsedDomain = DraftDomain.safeParse(domain);
    if (domain.trim() === "") found.domain = requiredText("domain");
    else if (!parsedDomain.success) found.domain = describeIssue("domain", parsedDomain.error.issues[0]!);
    const parsedName = BrandName.safeParse(name);
    if (name.trim() !== "" && !parsedName.success) found.name = describeIssue("name", parsedName.error.issues[0]!);
    setErrors(found);
    if (found.domain || found.name) return;
    setBusy(true);
    setNotice(null);
    try {
      const copy = await api.duplicateBrand(source.brand_id, { domain: domain.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      onDuplicated(copy.brand.brand_id);
    } catch (e) {
      setNotice(wizardErrorText(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, display: "grid", placeItems: "center", padding: 16, overflowY: "auto", background: "color-mix(in srgb, var(--ink) 35%, transparent)" }} role="dialog" aria-modal="true" aria-label="ทำสำเนาแบรนด์ (Duplicate brand)">
      <form className="panel" style={{ width: "100%", maxWidth: 560, maxHeight: "calc(100dvh - 32px)", overflowY: "auto", display: "grid", gap: 12 }} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2>ทำสำเนาแบรนด์ (Duplicate brand)</h2>
        <p className="hint">คัดลอกเทมเพลต คีย์เวิร์ด ข้อมูลโปรไฟล์ และข้อความหน้าเว็บของ {source.name ?? source.brand_id} ไม่คัดลอกโดเมน รหัส เช็กลิสต์ หรือสถานะติดตั้ง (Copies the template, keyword, profile and site text. The domain, ids, checklist and install state are not copied.)</p>
        <label>โดเมนใหม่ (New domain)<input required value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" aria-invalid={errors.domain ? true : undefined} /></label>
        {errors.domain && <p className="neg" role="alert">{errors.domain}</p>}
        <label>ชื่อแบรนด์ใหม่ (New brand name, optional)<input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={errors.name ? true : undefined} /></label>
        {errors.name && <p className="neg" role="alert">{errors.name}</p>}
        {notice && <p className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">{notice}</p>}
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button type="submit" className="btn pri" disabled={busy}>ทำสำเนา (Duplicate)</button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>ยกเลิก (Cancel)</button>
        </div>
      </form>
    </div>
  );
}
