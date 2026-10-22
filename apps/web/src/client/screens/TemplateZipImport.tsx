import { TemplateZipImportRequest, templateSlug, type TemplateSubmitResult, type TemplateZipType } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api } from "../api";
import { inspectTemplateZip } from "../template-zip";

export function TemplateZipImport({ busy, onBusy, onResult, onError }: {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onResult: (result: TemplateSubmitResult) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<TemplateZipType | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetected(null);
    setError(null);
    setInspecting(!!file);
    if (file) void inspectTemplateZip(file).then(
      (type) => { if (!cancelled) { setDetected(type); setInspecting(false); } },
      (e: unknown) => { if (!cancelled) { setError(e instanceof Error ? e.message : "อ่าน ZIP ไม่ได้ (Invalid ZIP)"); setInspecting(false); } },
    );
    return () => { cancelled = true; };
  }, [file]);

  async function submit() {
    if (!file || !detected || inspecting) return;
    const fields = TemplateZipImportRequest.safeParse({ template_name: name, template_id: id });
    if (!fields.success) return;
    onBusy(true);
    try {
      await onResult(await api.importTemplateZip(fields.data, file));
    } catch (e) {
      onError(e);
    } finally {
      onBusy(false);
    }
  }

  return (
    <form className="panel" style={{ display: "grid", gap: 10, alignContent: "start" }} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>นำเข้าไฟล์ ZIP</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 12 }}>
      <label>ชื่อเทมเพลต
        <input aria-label="ชื่อเทมเพลต ZIP (ZIP template name)" placeholder="Pastel Lending" value={name} maxLength={128} required disabled={busy} onChange={(e) => {
          setName(e.target.value);
          if (!idEdited) setId(e.target.value.trim() ? templateSlug(e.target.value) : "");
        }} />
      </label>
      <label>รหัส
        <input aria-label="รหัสเทมเพลต (Template ID)" placeholder="pastel-lending" value={id} maxLength={63} pattern="[a-z0-9][a-z0-9-]{1,62}" required disabled={busy} onChange={(e) => { setIdEdited(true); setId(e.target.value); }} />
      </label>
      </div>
      <label style={{ border: "1.5px dashed var(--line)", borderRadius: 10, padding: 18, textAlign: "center" }}>เลือกไฟล์ ZIP ที่ build แล้ว
        <input aria-label="ไฟล์ ZIP (ZIP file)" type="file" accept=".zip,application/zip" required disabled={busy} onChange={(e) => { setDetected(null); setFile(e.target.files?.[0] ?? null); }} />
      </label>
      <p className="hint">ระบบดูชนิดให้เอง Astro, Bolt หรือ Vite React · สูงสุด 30 MB · 2,000 ไฟล์ · 10 MB ต่อไฟล์</p>
      <p role="status">{inspecting ? "กำลังตรวจ ZIP (Inspecting ZIP)" : `ชนิดที่ตรวจพบ (Detected type): ${detected ?? "-"}`}</p>
      {error && <p className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">{error === "Upload the built dist folder" ? "อัปโหลดโฟลเดอร์ dist ที่ build แล้ว (Upload the built dist folder)" : error}</p>}
      <button className="btn pri" style={{ justifySelf: "start" }} type="submit" aria-label="นำเข้า ZIP (Import ZIP)" disabled={busy || inspecting || !detected || !TemplateZipImportRequest.safeParse({ template_name: name, template_id: id }).success}>นำเข้า ZIP</button>
    </form>
  );
}
