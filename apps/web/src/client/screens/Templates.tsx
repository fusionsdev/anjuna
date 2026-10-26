import { TemplateSubmitIssue, TemplateThemeVars } from "@anjuna/contracts";
import { ruleDisposition } from "@anjuna/template-cert/policy";
import type { TemplateDetailResponse, TemplateReviewStatus, TemplateSubmitResult, TemplateVersionSummary } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { useConfirm } from "../components/ConfirmDialog";
import { TemplateZipImport } from "./TemplateZipImport";

const statusLabel: Record<TemplateReviewStatus, string> = {
  checking: "กำลังตรวจ",
  rejected: "ไม่ผ่าน",
  awaiting_approval: "รออนุมัติ",
  approved: "ใช้ได้",
};
const statusPill: Record<TemplateReviewStatus, string> = { checking: "p-blue", rejected: "p-bad", awaiting_approval: "p-warn", approved: "p-live" };

const errorText = (e: unknown) => (e instanceof ApiError ? (e.body?.message ?? e.thai) : "ไม่สำเร็จ");

export function TemplatesScreen({ me, selectedId, onSelect }: { me: Me; selectedId?: string | null; onSelect?: (id: string | null) => void }) {
  const [templates, setTemplates] = useState<TemplateVersionSummary[] | null>(null);
  // Without onSelect the screen keeps its own selection (it renders alone in tests); with it the URL owns the selection.
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const selected = onSelect ? (selectedId ?? null) : ownSelected;
  const select = (id: string | null) => (onSelect ? onSelect(id) : setOwnSelected(id));
  const [detail, setDetail] = useState<TemplateDetailResponse | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({ url: "", template_name: "" });
  const [imported, setImported] = useState<TemplateSubmitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const [filter, setFilter] = useState<TemplateReviewStatus | "all">("all");
  const visibleTemplates = (templates ?? []).filter((t) => filter === "all" || t.status === filter);

  const load = useCallback(() => api.templates().then((r) => setTemplates(r.templates), (e) => setMsg({ kind: "err", text: errorText(e) })), []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    setDetail(null);
    if (selected) void api.template(selected).then(setDetail, (e) => setMsg({ kind: "err", text: errorText(e) }));
  }, [selected]);

  async function approve(id: string, themeVars?: TemplateThemeVars) {
    const target = templates?.find((t) => t.template_version_id === id) ?? (detail?.template.template_version_id === id ? detail.template : null);
    const ok = await confirm({
      title: "อนุมัติเทมเพลต (Approve template)?",
      body: target ? `${target.name} v${target.version}` : id,
      confirmLabel: "อนุมัติ (Approve)",
    });
    if (!ok) return;
    setMsg(null);
    setBusy(true);
    try {
      const r = await api.approveTemplate(id, themeVars);
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
      if (r.template_version_id) select(r.template_version_id);
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {confirmDialog}
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <h1 aria-label="เทมเพลต (Templates)">เทมเพลต</h1>
          <p className="hint">{templates ? `${templates.filter((t) => t.status === "awaiting_approval").length} รายการรอ Owner อนุมัติ` : "กำลังโหลด…"}</p>
        </div>
        <div className="seg" role="group" aria-label="กรองสถานะเทมเพลต" style={{ flexWrap: "wrap" }}>
          {([
            ["all", "ทั้งหมด"], ["approved", "ใช้ได้"], ["awaiting_approval", "รออนุมัติ"], ["rejected", "ไม่ผ่าน"], ["checking", "กำลังตรวจ"],
          ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
      </div>
      {msg && <div className={msg.kind === "ok" ? "note pos" : "note neg"} style={{ background: msg.kind === "ok" ? "var(--moneybg)" : "var(--badbg)", color: msg.kind === "ok" ? "var(--money)" : "var(--bad)" }} role="status">{msg.text}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 16, marginBottom: 16 }}>
      <TemplateZipImport busy={busy} onBusy={(value) => {
        setBusy(value);
        if (value) { setMsg(null); setImported(null); }
      }} onError={(e) => setMsg({ kind: "err", text: errorText(e) })} onResult={async (r) => {
        setImported(r);
        if (r.template_version_id) select(r.template_version_id);
        await load();
      }} />
      <section className="panel" style={{ display: "grid", gap: 10, alignContent: "start" }}>
        <h2>นำเข้าจาก URL</h2>
        <label>ลิงก์หน้าเว็บที่เผยแพร่แล้ว
          <input aria-label="URL ของเว็บที่เผยแพร่ (Published URL)" placeholder="https://pastel-lending.bolt.host" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </label>
        <label>ชื่อเทมเพลต
          <input aria-label="ชื่อเทมเพลต (Template name)" placeholder="Pastel Lending" maxLength={128} value={form.template_name} onChange={(e) => setForm({ ...form, template_name: e.target.value })} />
        </label>
        <button className="btn pri" aria-label="นำเข้า (Import)" style={{ justifySelf: "start" }} disabled={busy || !form.url.trim() || !form.template_name.trim()} onClick={() => void importUrl()}>นำเข้า</button>
        <p className="hint">กฎที่บล็อกมี 4 ข้อ: ชื่อแบรนด์อื่น, script ภายนอก, ปุ่มต้องไป /go, หน้ากฎหมายครบ 4 หน้า</p>
      </section>
      </div>
      {imported && <SubmitOutcome result={imported} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 14 }}>
        {visibleTemplates.map((t) => {
          const currentDetail = detail?.template.template_version_id === t.template_version_id ? detail : null;
          const warnings = currentDetail?.checks.flatMap((c) => [...checkWarnings(c.details).filter((i) => ruleDisposition(i.rule) === "warn"), ...checkWarnings(c.details, "import_warnings")]) ?? [];
          const status = currentDetail?.template.status ?? t.status;
          return (
            <article key={t.template_version_id} className="panel" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column", borderColor: t.template_version_id === selected ? "var(--money)" : "var(--line)" }}>
              <button type="button" aria-pressed={t.template_version_id === selected} onClick={() => select(t.template_version_id)} style={{ border: 0, padding: 0, background: "transparent", color: "var(--ink)", textAlign: "left", width: "100%", flex: 1 }}>
                {t.thumbnail_url ? <img src={t.thumbnail_url} alt={`ตัวอย่าง ${t.name} (Template preview)`} loading="lazy" style={{ width: "100%", aspectRatio: "16 / 10", objectFit: "cover", display: "block", borderBottom: "1px solid var(--line)" }} /> : <span className="hint" style={{ display: "grid", placeItems: "center", aspectRatio: "16 / 10", background: "var(--paper)", borderBottom: "1px solid var(--line)" }}>ไม่มีภาพตัวอย่าง (No preview)</span>}
                <span style={{ display: "grid", gap: 6, padding: "12px 14px" }}>
                  <span style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}><strong style={{ fontWeight: 500 }}>{t.name}</strong><span>v{t.version}</span></span>
                  <span><span className={`pill ${statusPill[status]}`}>{statusLabel[status]}</span></span>
                  <span className="hint">แบรนด์ที่ใช้ (Brands using): {t.brands_using}</span>
                  {warnings.length > 0 && <span className="amb">คำเตือน {warnings.length} ข้อ ไม่บล็อก</span>}
                  {!currentDetail && <span className="hint">ดูผลตรวจและคำเตือน</span>}
                  <span className="hint">ส่งโดย {t.submitted_by_label ?? "-"} · {t.created_at}</span>
                </span>
              </button>
              {me.role === "owner" && status === "awaiting_approval" && !currentDetail && <button type="button" className="btn pri" style={{ margin: "0 14px 12px", alignSelf: "start" }} aria-label={`อนุมัติ ${t.name} v${t.version}`} disabled={busy} onClick={() => void approve(t.template_version_id)}>อนุมัติ</button>}
            </article>
          );
        })}
      </div>
      {templates?.length === 0 && <p className="hint">ยังไม่มีเทมเพลต (No templates yet)</p>}
      {templates && templates.length > 0 && visibleTemplates.length === 0 && <p className="hint">ไม่มีเทมเพลตในสถานะนี้</p>}
      {detail && <TemplateDetail me={me} detail={detail} busy={busy} onApprove={(themeVars) => void approve(detail.template.template_version_id, themeVars)} />}
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
  return <div className="note" role="note" aria-label="คำเตือน (Warnings)">
    <b>คำเตือน (Warnings)</b>
    <ul>{issues.map((issue, i) => <li key={i}><code>{issue.rule}</code> {issue.file ? issue.file + ": " : ""}{issue.message}{" "}<span>{issue.fix}</span></li>)}</ul>
  </div>;
}

const THEME_ROLES = [
  ["primary", "สีหลัก (Primary)"],
  ["primary_dark", "สีหลักเข้ม (Primary dark)"],
  ["secondary", "สีรอง (Secondary)"],
] as const;
const joinNames = (names: readonly string[] | undefined) => (names ?? []).join(", ");

function TemplateDetail({ me, detail, busy, onApprove }: { me: Me; detail: TemplateDetailResponse; busy: boolean; onApprove: (themeVars: TemplateThemeVars) => void }) {
  const t = detail.template;
  const [themeText, setThemeText] = useState(() => ({
    primary: joinNames(t.theme_vars?.primary), primary_dark: joinNames(t.theme_vars?.primary_dark), secondary: joinNames(t.theme_vars?.secondary),
  }));
  const [themeError, setThemeError] = useState<string | null>(null);
  const editable = me.role === "owner" && t.status === "awaiting_approval";
  const detected = t.theme_vars && t.theme_vars.primary.length + t.theme_vars.primary_dark.length + t.theme_vars.secondary.length > 0 ? t.theme_vars : null;
  function submitApprove() {
    const names = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);
    const parsed = TemplateThemeVars.safeParse({ primary: names(themeText.primary), primary_dark: names(themeText.primary_dark), secondary: names(themeText.secondary) });
    if (!parsed.success) {
      setThemeError("ชื่อตัวแปรไม่ถูกต้อง ใช้รูปแบบ --ชื่อ คั่นด้วยจุลภาค สูงสุด 8 ชื่อ (Invalid variable name: use --name, comma separated, at most 8)");
      return;
    }
    setThemeError(null);
    onApprove(parsed.data);
  }
  const identity = detail.checks.find((c) => c.check_name === "identity_scan");
  const similarity = (identity?.details as { similarity?: { summary?: string } } | null | undefined)?.similarity?.summary ?? null;
  const defaults = t.text_defaults;
  const warnings = detail.checks.flatMap((c) => checkWarnings(c.details).filter((i) => ruleDisposition(i.rule) === "warn"));
  const importWarnings = detail.checks.flatMap((c) => checkWarnings(c.details, "import_warnings"));
  return (
    <section className="panel" style={{ marginTop: 16 }} aria-label="รายละเอียดเทมเพลต (Template detail)">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <h2>{`${t.name} · v${t.version}`}</h2>
        <span className={`pill ${statusPill[t.status]}`}>{statusLabel[t.status]}</span>
      </div>
      <p className="hint">{t.template_version_id} · ส่งโดย (Submitted by) {t.submitted_by_label ?? "-"} · <code>{t.sha256.slice(0, 12)}</code></p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 16, marginBlock: 16 }}>
        {(["desktop", "mobile"] as const).map((viewport) =>
          detail.screenshots[viewport]
            ? <img key={viewport} style={{ maxWidth: "100%", maxHeight: 480, objectFit: "contain" }} src={detail.screenshots[viewport]!} alt={`ภาพหน้าจอ ${viewport} (${viewport} screenshot)`} />
            : <p key={viewport} className="hint">{`ไม่มีภาพ ${viewport} (No ${viewport} screenshot)`}</p>)}
      </div>
      <h3>ผลการตรวจ (Checks)</h3>
      <ul>
        {detail.checks.map((c) => {
          const advisory = checkWarnings(c.details).length > 0 || checkWarnings(c.details, "import_warnings").length > 0 || (c.result === "fail" && ruleDisposition(c.check_name) === "warn");
          const blocking = c.result === "fail" && ruleDisposition(c.check_name) === "block";
          return <li key={c.check_name}><span className={`pill ${blocking ? "p-bad" : advisory ? "p-warn" : "p-live"}`}>{blocking ? "fail" : advisory ? "คำเตือน (Warning)" : "pass"}</span> {c.check_name}</li>;
        })}
      </ul>
      <Warnings issues={[...warnings, ...importWarnings]} />
      {similarity && <p className="hint">ความคล้าย (Similarity): {similarity}</p>}
      <h3>ข้อความเริ่มต้น (Text defaults)</h3>
      <div className="ledger" style={{ marginBlock: 12 }}>
        <div className="cell"><span className="k" style={{ display: "block" }}>ชื่อแบรนด์ (Brand name)</span><b>{defaults?.brand_name ?? "-"}</b></div>
        <div className="cell"><span className="k" style={{ display: "block" }}>ชื่อหน้า (Page title)</span><b>{defaults?.title ?? "-"}</b></div>
        <div className="cell"><span className="k" style={{ display: "block" }}>คำอธิบาย (Meta description)</span><b>{defaults?.description ?? "-"}</b></div>
      </div>
      <h3>ตัวแปรสี (Color variables)</h3>
      {editable ? (
        <div style={{ display: "grid", gap: 8, marginBlock: 12 }}>
          {THEME_ROLES.map(([role, label]) => (
            <label key={role}>{label}
              <input aria-label={label} placeholder="--brand-color, --accent" value={themeText[role]} onChange={(e) => setThemeText({ ...themeText, [role]: e.target.value })} />
            </label>
          ))}
          {themeError && <p className="note neg" role="alert">{themeError}</p>}
        </div>
      ) : detected ? (
        <div className="ledger" style={{ marginBlock: 12 }}>
          {THEME_ROLES.map(([role, label]) => <div key={role} className="cell"><span className="k" style={{ display: "block" }}>{label}</span><b>{joinNames(detected[role]) || "-"}</b></div>)}
        </div>
      ) : <p className="hint">ไม่พบตัวแปรสี (No color variables found)</p>}
      {editable && (
        <button className="btn pri" disabled={busy} onClick={submitApprove}>อนุมัติ (Approve)</button>
      )}
    </section>
  );
}

function SubmitOutcome({ result }: { result: TemplateSubmitResult }) {
  const title = result.status === "awaiting_approval" ? "ส่งแล้ว รออนุมัติ (Awaiting approval)" : result.status === "duplicate" ? "ซ้ำกับเวอร์ชันเดิม (Duplicate)" : "ไม่ผ่าน (Rejected)";
  return (
    <div className={result.status === "rejected" ? "note neg" : "note pos"} style={{ background: result.status === "rejected" ? "var(--badbg)" : "var(--moneybg)", color: result.status === "rejected" ? "var(--bad)" : "var(--money)" }} role="status">
      <b>{title}</b>
      <p>{result.next_step}</p>
      <Warnings issues={result.warnings} />
      {result.issues.length > 0 && (
        <ul>{result.issues.map((issue, i) => <li key={i}><code>{issue.rule}</code> {issue.file ? `${issue.file}: ` : ""}{issue.message}{" "}<span className="hint">{issue.fix}</span></li>)}</ul>
      )}
    </div>
  );
}
