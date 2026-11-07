// Owner-only upgrade-all picker. Sends the same body the old Brands card sent.
import type { TemplateVersionSummary } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { useConfirm } from "../components/ConfirmDialog";
import { Toast } from "../components/Toast";
import { UpgradeOutcomes } from "./UpgradeOutcomes";

type Me = { id: string; email: string; role: string };

const optionLabel = (t: TemplateVersionSummary) => `${t.name} v${t.version}${t.archived ? " (เก็บแล้ว)" : ""}`;

export function UpgradeWizard({ me }: { me: Me }) {
  const owner = me.role === "owner";
  const [fromList, setFromList] = useState<TemplateVersionSummary[]>([]);
  const [toList, setToList] = useState<TemplateVersionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ from_template_version_id: "", to_template_version_id: "", form_artifact_id: "", canary_brand_id: "" });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => {
    if (!owner) return;
    let active = true;
    // A sealed version of an archived template is a valid "from". The "to" list hides archived templates.
    Promise.all([api.templates({ includeArchived: true }), api.templates()]).then(
      ([all, live]) => {
        if (!active) return;
        setFromList(all.templates.filter((t) => t.sealed_at));
        setToList(live.templates.filter((t) => t.sealed_at));
      },
      (e: unknown) => { if (active) setLoadError(e instanceof ApiError ? e.thai : "โหลดรายการเทมเพลตไม่สำเร็จ"); },
    );
    return () => { active = false; };
  }, [owner]);

  if (!owner) return null;

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function start() {
    if (busy) return;
    const ok = await confirm({
      title: "เริ่มอัปเกรดทุกแบรนด์?",
      body: `อัปเกรดทุกแบรนด์จาก ${form.from_template_version_id || "—"} ไป ${form.to_template_version_id || "—"} โดยทดลองกับ ${form.canary_brand_id || "—"} ก่อน`,
      confirmLabel: "เริ่มอัปเกรด",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.upgradeAll(form);
      setRefresh((n) => n + 1);
      setToast({ kind: "ok", text: "รับคำสั่งอัปเกรดแล้ว" });
    } catch (e) {
      setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "สั่งอัปเกรดไม่สำเร็จ" });
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel upgrade-card">
    <h2>อัปเกรดทุกแบรนด์ (เฉพาะเจ้าของ)</h2>
    <p className="muted">อัปเกรดแบบ canary ก่อน; target artifact ต้องมี payload <code>2026-01</code> และ bundle identity แยกเป็น <code>form@…</code></p>
    {loadError && <p role="alert">{loadError}</p>}
    <div className="form-inline">
      <select aria-label="เวอร์ชันเดิม" value={form.from_template_version_id} onChange={set("from_template_version_id")}>
        <option value="">เลือกเวอร์ชันเดิม</option>
        {fromList.map((t) => <option key={t.template_version_id} value={t.template_version_id}>{optionLabel(t)}</option>)}
      </select>
      <select aria-label="เวอร์ชันใหม่" value={form.to_template_version_id} onChange={set("to_template_version_id")}>
        <option value="">เลือกเวอร์ชันใหม่</option>
        {toList.map((t) => <option key={t.template_version_id} value={t.template_version_id}>{optionLabel(t)}</option>)}
      </select>
      <input aria-label="form_artifact_id" placeholder="form_artifact_id" value={form.form_artifact_id} onChange={set("form_artifact_id")} />
      <input aria-label="canary_brand_id" placeholder="canary_brand_id" value={form.canary_brand_id} onChange={set("canary_brand_id")} />
      <button type="button" className="btn danger" disabled={busy} onClick={() => void start()}>เริ่มอัปเกรดทุกแบรนด์</button>
    </div>
    <UpgradeOutcomes refresh={refresh} />
    {confirmDialog}
    {toast && <Toast kind={toast.kind} text={toast.text} onDismiss={() => setToast(null)} />}
  </section>;
}
