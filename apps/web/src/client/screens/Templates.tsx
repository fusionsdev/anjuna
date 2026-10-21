import { TemplateSubmitIssue } from "@anjuna/contracts";
import { ruleDisposition } from "@anjuna/template-cert/policy";
import type { TemplateDetailResponse, TemplateReviewStatus, TemplateSubmitResult, TemplateVersionSummary } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";

const statusLabel: Record<TemplateReviewStatus, string> = {
  checking: "กำลังตรวจ (Checking)",
  rejected: "ไม่ผ่าน (Rejected)",
  awaiting_approval: "รออนุมัติ (Awaiting approval)",
  approved: "อนุมัติแล้ว (Approved)",
};
const statusPill: Record<TemplateReviewStatus, string> = { checking: "", rejected: "alert", awaiting_approval: "warn", approved: "ok" };

const errorText = (e: unknown) => (e instanceof ApiError ? (e.body?.message ?? e.thai) : "ไม่สำเร็จ");

function selectedFromHash(): string | null {
  const match = /^#templates\/(.+)$/.exec(window.location.hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null; // a malformed escape such as "#templates/%" opens the list
  }
}

export function TemplatesScreen({ me }: { me: Me }) {
  const [templates, setTemplates] = useState<TemplateVersionSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedFromHash);
  const [detail, setDetail] = useState<TemplateDetailResponse | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({ url: "", template_name: "" });
  const [imported, setImported] = useState<TemplateSubmitResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.templates().then((r) => setTemplates(r.templates), (e) => setMsg({ kind: "err", text: errorText(e) })), []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const onHash = () => { if (window.location.hash.startsWith("#templates/")) setSelected(selectedFromHash()); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    setDetail(null);
    if (selected) void api.template(selected).then(setDetail, (e) => setMsg({ kind: "err", text: errorText(e) }));
  }, [selected]);

  async function approve(id: string) {
    setMsg(null);
    setBusy(true);
    try {
      const r = await api.approveTemplate(id);
      setMsg({ kind: "ok", text: r.already_sealed ? "อนุมัติไว้แล้ว (Already approved)" : "อนุมัติแล้ว (Approved)" });
      await load();
      setDetail(await api.template(id));
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function importUrl() {
    setMsg(null);
    setImported(null);
    setBusy(true);
    try {
      const r = await api.importTemplate(form);
      setImported(r);
      if (r.template_version_id) setSelected(r.template_version_id);
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>เทมเพลต (Templates)</h1>
      {msg && <div className={msg.kind === "ok" ? "ok" : "error"} role="status">{msg.text}</div>}
      <section className="card">
        <div className="form-inline">
          <h2>นำเข้าจาก URL (Import from URL)</h2>
          <input aria-label="URL ของเว็บที่เผยแพร่ (Published URL)" placeholder="https://…" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <input aria-label="ชื่อเทมเพลต (Template name)" placeholder="ชื่อเทมเพลต (Template name)" maxLength={128} value={form.template_name} onChange={(e) => setForm({ ...form, template_name: e.target.value })} />
          <button className="primary" disabled={busy || !form.url.trim() || !form.template_name.trim()} onClick={() => void importUrl()}>นำเข้า (Import)</button>
        </div>
        {imported && <SubmitOutcome result={imported} />}
      </section>
      <table className="table clickable">
        <thead>
          <tr><th>เทมเพลต (Template)</th><th>เวอร์ชัน (Version)</th><th>สถานะ (Status)</th><th>ส่งโดย (Submitted by)</th><th>เวลา (Created)</th></tr>
        </thead>
        <tbody>
          {(templates ?? []).map((t) => (
            <tr key={t.template_version_id} className={t.template_version_id === selected ? "selected" : undefined} onClick={() => setSelected(t.template_version_id)}>
              <td>{t.name}</td>
              <td>v{t.version}</td>
              <td><span className={`pill ${statusPill[t.status]}`}>{statusLabel[t.status]}</span></td>
              <td>{t.submitted_by_label ?? "-"}</td>
              <td className="muted small">{t.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {templates?.length === 0 && <p className="muted">ยังไม่มีเทมเพลต (No templates yet)</p>}
      {detail && <TemplateDetail me={me} detail={detail} busy={busy} onApprove={() => void approve(detail.template.template_version_id)} />}
    </>
  );
}

function checkWarnings(details: unknown, key: "warning_issues" | "import_warnings" = "warning_issues"): TemplateSubmitIssue[] {
  if (!details || typeof details !== "object") return [];
  const parsed = TemplateSubmitIssue.array().safeParse((details as Record<string, unknown>)[key]);
  return parsed.success ? parsed.data : [];
}

function Warnings({ issues }: { issues: TemplateSubmitIssue[] }) {
  if (!issues.length) return null;
  return <div className="warn" role="note" aria-label="คำเตือน (Warnings)">
    <b>คำเตือน (Warnings)</b>
    <ul>{issues.map((issue, i) => <li key={i}><code>{issue.rule}</code> {issue.file ? issue.file + ": " : ""}{issue.message}{" "}<span>{issue.fix}</span></li>)}</ul>
  </div>;
}

function TemplateDetail({ me, detail, busy, onApprove }: { me: Me; detail: TemplateDetailResponse; busy: boolean; onApprove: () => void }) {
  const t = detail.template;
  const identity = detail.checks.find((c) => c.check_name === "identity_scan");
  const similarity = (identity?.details as { similarity?: { summary?: string } } | null | undefined)?.similarity?.summary ?? null;
  const defaults = t.text_defaults;
  const warnings = detail.checks.flatMap((c) => checkWarnings(c.details).filter((i) => ruleDisposition(i.rule) === "warn"));
  const importWarnings = detail.checks.flatMap((c) => checkWarnings(c.details, "import_warnings"));
  return (
    <section className="card section" aria-label="รายละเอียดเทมเพลต (Template detail)">
      <div className="row split">
        <h2>{`${t.name} · v${t.version}`}</h2>
        <span className={`pill ${statusPill[t.status]}`}>{statusLabel[t.status]}</span>
      </div>
      <p className="muted small">{t.template_version_id} · ส่งโดย (Submitted by) {t.submitted_by_label ?? "-"} · <code>{t.sha256.slice(0, 12)}</code></p>
      <div className="template-shots">
        {(["desktop", "mobile"] as const).map((viewport) =>
          detail.screenshots[viewport]
            ? <img key={viewport} src={detail.screenshots[viewport]!} alt={`ภาพหน้าจอ ${viewport} (${viewport} screenshot)`} />
            : <p key={viewport} className="muted">{`ไม่มีภาพ ${viewport} (No ${viewport} screenshot)`}</p>)}
      </div>
      <h3>ผลการตรวจ (Checks)</h3>
      <ul>
        {detail.checks.map((c) => {
          const advisory = checkWarnings(c.details).length > 0 || checkWarnings(c.details, "import_warnings").length > 0 || (c.result === "fail" && ruleDisposition(c.check_name) === "warn");
          const blocking = c.result === "fail" && ruleDisposition(c.check_name) === "block";
          return <li key={c.check_name}><span className={`pill ${blocking ? "alert" : advisory ? "warn" : "ok"}`}>{blocking ? "fail" : advisory ? "คำเตือน (Warning)" : "pass"}</span> {c.check_name}</li>;
        })}
      </ul>
      <Warnings issues={[...warnings, ...importWarnings]} />
      {similarity && <p className="small">ความคล้าย (Similarity): {similarity}</p>}
      <h3>ข้อความเริ่มต้น (Text defaults)</h3>
      <div className="status-grid">
        <div><span className="muted small">ชื่อแบรนด์ (Brand name)</span><b>{defaults?.brand_name ?? "-"}</b></div>
        <div><span className="muted small">ชื่อหน้า (Page title)</span><b>{defaults?.title ?? "-"}</b></div>
        <div><span className="muted small">คำอธิบาย (Meta description)</span><b>{defaults?.description ?? "-"}</b></div>
      </div>
      {me.role === "owner" && t.status === "awaiting_approval" && (
        <button className="primary" disabled={busy} onClick={onApprove}>อนุมัติ (Approve)</button>
      )}
    </section>
  );
}

function SubmitOutcome({ result }: { result: TemplateSubmitResult }) {
  const title = result.status === "awaiting_approval" ? "ส่งแล้ว รออนุมัติ (Awaiting approval)" : result.status === "duplicate" ? "ซ้ำกับเวอร์ชันเดิม (Duplicate)" : "ไม่ผ่าน (Rejected)";
  return (
    <div className={result.status === "rejected" ? "error" : "ok"} role="status">
      <b>{title}</b>
      <p>{result.next_step}</p>
      <Warnings issues={result.warnings} />
      {result.issues.length > 0 && (
        <ul>{result.issues.map((issue, i) => <li key={i}><code>{issue.rule}</code> {issue.file ? `${issue.file}: ` : ""}{issue.message}{" "}<span className="muted">{issue.fix}</span></li>)}</ul>
      )}
    </div>
  );
}
