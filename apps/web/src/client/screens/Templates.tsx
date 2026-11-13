import { TemplateSubmitIssue, TemplateThemeVars, isEmptyThemeVars } from "@anjuna/contracts";
import { ruleDisposition } from "@anjuna/template-cert/policy";
import type { TemplateCategory, TemplateDetailResponse, TemplateSubmitResult, TemplateVersionSummary } from "@anjuna/contracts";
import { Info, Upload, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";
import type { TemplateStatusFilter } from "../router";
import { awaitingApproval } from "../task-counts";
import { approveBlockedText, approvedWithFailuresText, similarityFailures } from "../template-similarity";
import { Chip } from "../components/Chip";
import { useConfirm } from "../components/ConfirmDialog";
import { CategoryList, type CategoryFilter } from "./TemplateCategories";
import { BulkBar, REFUSAL_TEXT, TemplateTable, statusLabel, statusTone } from "./TemplateTable";
import { TemplateZipImport } from "./TemplateZipImport";
import "./Templates.css";

const errorText = (e: unknown) => (e instanceof ApiError ? (e.body?.message ?? REFUSAL_TEXT[e.body?.error ?? ""] ?? e.thai) : "ไม่สำเร็จ");

type StatusFilter = TemplateStatusFilter;
const STATUS_CHIPS: Array<[StatusFilter, string]> = [
  ["all", "ทุกสถานะ"], ["approved", "ใช้ได้"], ["awaiting_approval", "รออนุมัติ"], ["rejected", "ไม่ผ่าน"], ["checking", "กำลังตรวจ"], ["archived", "เก็บถาวร"],
];

/** Whether a version shows under a status chip. รออนุมัติ is the predicate the Home card and the sidebar badge count with. */
const matchesStatus = (t: TemplateVersionSummary, id: StatusFilter) =>
  id === "archived" ? t.archived : id === "awaiting_approval" ? awaitingApproval(t) : !t.archived && (id === "all" || t.status === id);

/** Distinct templates: a template with several versions is one archive or delete target. */
const uniqueTemplates = (items: TemplateVersionSummary[]) => [...new Map(items.map((t) => [t.template_id, t])).values()];

/** status and onStatus: the `?status=` of the URL and the setter that writes it. Without onStatus the screen keeps the filter itself. */
/** onCountsChanged: called after a write that may change the sidebar's template badge (approve, archive, delete, import). */
export function TemplatesScreen({ me, selectedId, onSelect, status, onStatus, onCountsChanged }: { me: Me; selectedId?: string | null; onSelect?: (id: string | null) => void; status?: StatusFilter | null; onStatus?: (status: StatusFilter) => void; onCountsChanged?: () => void }) {
  const [templates, setTemplates] = useState<TemplateVersionSummary[] | null>(null);
  // Without onSelect the screen keeps its own selection (it renders alone in tests); with it the URL owns the selection.
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const selected = onSelect ? (selectedId ?? null) : ownSelected;
  const select = (id: string | null) => (onSelect ? onSelect(id) : setOwnSelected(id));
  const [detail, setDetail] = useState<TemplateDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailTry, setDetailTry] = useState(0);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({ url: "", template_name: "" });
  const [imported, setImported] = useState<TemplateSubmitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const [ownFilter, setOwnFilter] = useState<StatusFilter>("all");
  const filter = onStatus ? (status ?? "all") : ownFilter;
  const [categories, setCategories] = useState<TemplateCategory[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [uploadOpen, setUploadOpen] = useState(false);
  // A refused delete keeps its reason on screen with an archive button, the safe alternative.
  const [refused, setRefused] = useState<{ templateId: string; name: string; reason: string } | null>(null);
  const owner = me.role === "owner";

  const inCategory = (t: TemplateVersionSummary) => categoryFilter === "all" || t.category_id === categoryFilter;
  const live = (templates ?? []).filter((t) => !t.archived);
  const visibleTemplates = (templates ?? []).filter((t) => inCategory(t) && matchesStatus(t, filter));
  const chipCount = (id: StatusFilter) => (templates ?? []).filter((t) => inCategory(t) && matchesStatus(t, id)).length;
  const categoryCounts = new Map<string, number>();
  for (const t of live) if (t.category_id) categoryCounts.set(t.category_id, (categoryCounts.get(t.category_id) ?? 0) + 1);
  const checkedItems = (templates ?? []).filter((t) => checked.has(t.template_version_id));

  const load = useCallback(() => api.templates({ includeArchived: true }).then((r) => {
    setTemplates(r.templates);
    setCategories(r.categories);
    // A version that left the list (deleted, or archived out of the view) cannot stay checked.
    setChecked((cur) => new Set([...cur].filter((id) => r.templates.some((t) => t.template_version_id === id))));
  }, (e) => setMsg({ kind: "err", text: errorText(e) })), []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    // A failed load shows its error inside the drawer, because the drawer and its scrim cover the page notice.
    if (selected) void api.template(selected).then(setDetail, (e) => setDetailError(e instanceof ApiError && e.status === 404 ? "ไม่พบเทมเพลตนี้ อาจถูกลบไปแล้ว" : errorText(e)));
  }, [selected, detailTry]);
  // Escape closes the upload dialog first, then the drawer. The confirm dialog stops its own Escape.
  useEffect(() => {
    if (!uploadOpen && !selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (uploadOpen) setUploadOpen(false);
      else onSelect ? onSelect(null) : setOwnSelected(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [uploadOpen, selected, onSelect]);

  const changeFilter = (next: StatusFilter) => { if (onStatus) onStatus(next); else setOwnFilter(next); setChecked(new Set()); };
  const changeCategory = (next: CategoryFilter) => { setCategoryFilter(next); setChecked(new Set()); };

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
      onCountsChanged?.();
      await load();
      setDetail(await api.template(id));
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  /** One template manager write: clear the old notices, run it, show the result, reload the list. */
  async function manage(action: () => Promise<unknown>, okText: string): Promise<boolean> {
    setMsg(null);
    setRefused(null);
    setBusy(true);
    try {
      await action();
      setMsg({ kind: "ok", text: okText });
      onCountsChanged?.();
      await load();
      return true;
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function archiveMany(items: TemplateVersionSummary[]) {
    const targets = uniqueTemplates(items.filter((t) => !t.archived));
    if (targets.length === 0) return;
    const names = targets.map((t) => t.name).join(", ");
    const ok = await confirm({
      title: "เก็บเทมเพลตเข้าคลัง?",
      body: `${names} จะไม่แสดงตอนเลือกเทมเพลตสร้างแบรนด์ แบรนด์ที่ใช้อยู่ยังทำงานต่อ`,
      confirmLabel: "เก็บถาวร",
    });
    if (!ok) return;
    const done = await manage(async () => { for (const t of targets) await api.archiveTemplate(t.template_id); },
      targets.length === 1 ? `เก็บ ${targets[0]!.name} เข้าคลังแล้ว` : `เก็บ ${targets.length} รายการเข้าคลังแล้ว`);
    if (done) setChecked(new Set());
  }

  async function removeMany(items: TemplateVersionSummary[]) {
    const targets = uniqueTemplates(items);
    if (targets.length === 0) return;
    const ok = await confirm({
      title: "ลบเทมเพลต?",
      body: `${targets.map((t) => t.name).join(", ")} และทุกเวอร์ชันจะถูกลบถาวร ลบได้เฉพาะเทมเพลตที่ไม่มีแบรนด์ใช้และไม่เคยอนุมัติ`,
      confirmLabel: "ลบ",
      tone: "danger",
    });
    if (!ok) return;
    setMsg(null);
    setRefused(null);
    setBusy(true);
    let deleted = 0;
    try {
      for (const t of targets) {
        try {
          await api.deleteTemplate(t.template_id);
          deleted += 1;
          // A deleted version cannot stay selected.
          if (templates?.some((x) => x.template_id === t.template_id && x.template_version_id === selected)) select(null);
        } catch (e) {
          // The first refusal stops the run: the ones already deleted stay deleted, the rest stay checked.
          const reason = e instanceof ApiError && e.status === 409 ? REFUSAL_TEXT[e.body?.error ?? ""] : undefined;
          if (reason) setRefused({ templateId: t.template_id, name: t.name, reason });
          else setMsg({ kind: "err", text: errorText(e) });
          break;
        }
      }
      if (deleted > 0) {
        setMsg({ kind: "ok", text: targets.length === 1 ? `ลบ ${targets[0]!.name} แล้ว` : `ลบ ${deleted} รายการแล้ว` });
        onCountsChanged?.();
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function moveMany(items: TemplateVersionSummary[], categoryId: string | null) {
    const targets = uniqueTemplates(items);
    const done = await manage(async () => { for (const t of targets) await api.setTemplateCategory(t.template_id, categoryId); }, `ย้าย ${targets.length} รายการแล้ว`);
    if (done) setChecked(new Set());
  }

  async function importUrl() {
    setMsg(null);
    setImported(null);
    setBusy(true);
    try {
      const r = await api.importTemplate(form);
      setImported(r);
      if (r.template_version_id) select(r.template_version_id);
      onCountsChanged?.();
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const noticeEl = msg && <div className="tpl-note" data-kind={msg.kind} role="status">{msg.text}</div>;
  const toggle = (id: string) => setChecked((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleAll = () => setChecked(visibleTemplates.every((t) => checked.has(t.template_version_id)) ? new Set() : new Set(visibleTemplates.map((t) => t.template_version_id)));

  return (
    <div className="tpl-page">
      {confirmDialog}
      <header className="tpl-head">
        <div>
          <h1 aria-label="เทมเพลต (Templates)">เทมเพลต</h1>
          <p className="hint">{templates ? `${templates.filter(awaitingApproval).length} รายการรอ Owner อนุมัติ` : "กำลังโหลด…"}</p>
        </div>
        <button type="button" className="btn pri" onClick={() => { setMsg(null); setImported(null); setUploadOpen(true); }}><Upload size={16} aria-hidden="true" />อัปโหลดเทมเพลต</button>
      </header>
      {!uploadOpen && noticeEl}
      {refused && (
        <div className="tpl-note" data-kind="err" role="alert" style={{ display: "grid", gap: 8 }}>
          <b>{refused.name}</b>
          <span>{refused.reason}</span>
          <span>เก็บถาวรแทนได้ เทมเพลตจะไม่แสดงตอนสร้างแบรนด์ แต่แบรนด์เดิมยังทำงานต่อ</span>
          <button type="button" className="btn" style={{ justifySelf: "start" }} disabled={busy} onClick={() => {
            const target = templates?.find((t) => t.template_id === refused.templateId);
            setRefused(null);
            if (target) void archiveMany([target]);
          }}>เก็บถาวรแทน</button>
        </div>
      )}
      <div className="tpl-layout">
        <CategoryList categories={categories} counts={categoryCounts} total={live.length} filter={categoryFilter} onFilter={changeCategory} owner={owner} busy={busy}
          onCreate={(name) => manage(() => api.createTemplateCategory(name), `เพิ่มหมวด ${name} แล้ว`)} />
        <div className="tpl-main">
          <div className="tpl-chips" role="group" aria-label="กรองสถานะเทมเพลต">
            {STATUS_CHIPS.map(([id, label]) => (
              <button type="button" key={id} className="tpl-chip" aria-pressed={filter === id} onClick={() => changeFilter(id)}>
                {label}<span className="tpl-chip-count">{chipCount(id)}</span>
              </button>
            ))}
          </div>
          <section className="tpl-card" aria-label="รายการเทมเพลต">
            {owner && checkedItems.length > 0 && (
              <BulkBar items={checkedItems} categories={categories} busy={busy} onMove={(categoryId) => void moveMany(checkedItems, categoryId)}
                onArchive={() => void archiveMany(checkedItems)} onDelete={() => void removeMany(checkedItems)} onClear={() => setChecked(new Set())} />
            )}
            {!templates ? <p className="tpl-empty">กำลังโหลด…</p> : templates.length === 0 ? <p className="tpl-empty">ยังไม่มีเทมเพลต</p> : visibleTemplates.length === 0 ? (
              <div className="tpl-empty"><b>ไม่มีเทมเพลตในมุมมองนี้</b><span>ลองเลือกหมวดหรือสถานะอื่น</span></div>
            ) : (
              <TemplateTable items={visibleTemplates} categories={categories} owner={owner} busy={busy} checked={checked} openId={selected}
                hasDetail={(id) => detail?.template.template_version_id === id} onToggle={toggle} onToggleAll={toggleAll} onOpen={select}
                onCategory={(t, categoryId) => void manage(() => api.setTemplateCategory(t.template_id, categoryId), "บันทึกหมวดแล้ว")}
                onApprove={(t) => void approve(t.template_version_id)} />
            )}
          </section>
          <footer className="tpl-foot">
            <Info size={16} aria-hidden="true" />
            <div>
              <p><b>ลบถาวร</b> ได้เฉพาะเทมเพลตที่ไม่มีแบรนด์ใช้อยู่ (แบรนด์ที่ใช้ = 0) และไม่เคยอนุมัติ</p>
              <p>ถ้ามีแบรนด์ใช้อยู่ ให้ <b>เก็บถาวร</b> แทน แบรนด์เดิมยังทำงานต่อได้ แต่แบรนด์ใหม่จะเลือกเทมเพลตนี้ไม่ได้</p>
            </div>
          </footer>
        </div>
      </div>
      {selected && (
        <div className="tpl-drawer-wrap">
          <div className="tpl-scrim" data-testid="template-scrim" onClick={() => select(null)} />
          <aside className="tpl-drawer" role="dialog" aria-label="เทมเพลตที่เลือก">
            <button type="button" className="tpl-close" aria-label="ปิดรายละเอียด" onClick={() => select(null)}><X size={18} aria-hidden="true" /></button>
            {detail ? <TemplateDetail key={detail.template.template_version_id} me={me} detail={detail} busy={busy} onApprove={(themeVars) => void approve(detail.template.template_version_id, themeVars)} onSaved={async () => {
              const id = detail.template.template_version_id;
              const fresh = await api.template(id);
              // The owner may have opened another template while the reload ran.
              setDetail((cur) => (cur?.template.template_version_id === id ? fresh : cur));
            }} /> : detailError ? (
              <div className="tpl-drawer-error" role="alert">
                <p>{detailError}</p>
                <button type="button" className="btn" onClick={() => setDetailTry((n) => n + 1)}>ลองใหม่</button>
              </div>
            ) : <p className="hint">กำลังโหลดรายละเอียด…</p>}
          </aside>
        </div>
      )}
      {uploadOpen && (
        <UploadDialog onClose={() => setUploadOpen(false)}>
          {noticeEl}
          <div className="tpl-upload-grid">
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
        </UploadDialog>
      )}
    </div>
  );
}

/** Modal for the zip and URL imports. A click on the scrim and the close button close it; Escape is handled by the screen. */
function UploadDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  return (
    <div className="tpl-modal-wrap">
      <div className="tpl-scrim" data-testid="upload-scrim" onClick={onClose} />
      <div className="tpl-modal" role="dialog" aria-modal="true" aria-label="อัปโหลดเทมเพลต">
        <header>
          <h2>อัปโหลดเทมเพลต</h2>
          <button type="button" ref={closeRef} className="tpl-close" aria-label="ปิดหน้าต่างอัปโหลด" onClick={onClose}><X size={18} aria-hidden="true" /></button>
        </header>
        <div className="tpl-modal-body">{children}</div>
      </div>
    </div>
  );
}

function checkWarnings(details: unknown, key: "warning_issues" | "import_warnings" = "warning_issues"): TemplateSubmitIssue[] {
  if (!details || typeof details !== "object") return [];
  const parsed = TemplateSubmitIssue.array().safeParse((details as Record<string, unknown>)[key]);
  return parsed.success ? parsed.data : [];
}

const MARKUP = /<\/?[a-z][^>]*>/i;
const BRAND_OUTSIDE = /^The template brand name "(.+)" appears (\d+) time\(s\) outside data-brand/;

/**
 * The owner's line for a warning whose text carries HTML markup meant for the template builder: a plain Thai hint
 * of what is wrong and who fixes it. Null when the warning has no markup and shows as stored.
 */
export function ownerHint(issue: TemplateSubmitIssue): string | null {
  if (!MARKUP.test(issue.message) && !MARKUP.test(issue.fix)) return null;
  const outside = BRAND_OUTSIDE.exec(issue.message);
  if (outside) return `ชื่อแบรนด์ "${outside[1]}" อยู่นอกช่องชื่อแบรนด์ ${outside[2]} จุด ระบบเปลี่ยนเป็นชื่อแบรนด์ให้ตอนติดตั้ง ถ้าอยากให้หน้าตัวอย่างตรงกัน ให้ผู้สร้างเทมเพลตแก้`;
  if (issue.message.startsWith("No element has data-brand")) return "เทมเพลตยังไม่มีช่องชื่อแบรนด์ แก้ชื่อแบรนด์จากแผงควบคุมไม่ได้ ให้ผู้สร้างเทมเพลตเพิ่ม";
  return "ข้อความในเทมเพลตยังไม่ตรงรูปแบบ ให้ผู้สร้างเทมเพลตแก้";
}

/** `plain` is the owner's drawer: a warning with builder markup shows its Thai hint in place of the raw text. */
function Warnings({ issues, plain = false }: { issues: TemplateSubmitIssue[]; plain?: boolean }) {
  if (!issues.length) return null;
  return <div className="note" role="note" aria-label="คำเตือน (Warnings)">
    <b>คำเตือน (Warnings)</b>
    <ul>{issues.map((issue, i) => {
      const hint = plain ? ownerHint(issue) : null;
      return hint
        ? <li key={i}>{hint}</li>
        : <li key={i}><code>{issue.rule}</code> {issue.file ? issue.file + ": " : ""}{issue.message}{" "}<span>{issue.fix}</span></li>;
    })}</ul>
  </div>;
}

/** The similarity FAIL lines of a version: the reason its approve button is off, or a warning once it is approved. */
function SimilarityGate({ failures, sealed }: { failures: string[]; sealed: boolean }) {
  if (failures.length === 0) return null;
  const title = sealed ? approvedWithFailuresText(failures.length) : approveBlockedText(failures.length);
  return <div className="note neg" role="alert" aria-label={title}>
    <b>{title}</b>
    <ul>{failures.map((line) => <li key={line}>{line}</li>)}</ul>
  </div>;
}

const THEME_ROLES = [
  ["primary", "สีหลัก"],
  ["primary_dark", "สีหลักเข้ม"],
  ["secondary", "สีรอง"],
] as const;
const joinNames = (names: readonly string[] | undefined) => (names ?? []).join(", ");

function TemplateDetail({ me, detail, busy, onApprove, onSaved }: { me: Me; detail: TemplateDetailResponse; busy: boolean; onApprove: (themeVars: TemplateThemeVars) => void; onSaved: () => Promise<void> }) {
  const t = detail.template;
  const [themeText, setThemeText] = useState(() => ({
    primary: joinNames(t.theme_vars?.primary), primary_dark: joinNames(t.theme_vars?.primary_dark), secondary: joinNames(t.theme_vars?.secondary),
  }));
  const [themeError, setThemeError] = useState<string | null>(null);
  const [themeNote, setThemeNote] = useState<{ kind: "ok" | "info"; text: string } | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const sealed = t.status === "approved";
  const owner = me.role === "owner";
  const editable = owner && (t.status === "awaiting_approval" || sealed);
  const detected = t.theme_vars && t.theme_vars.primary.length + t.theme_vars.primary_dark.length + t.theme_vars.secondary.length > 0 ? t.theme_vars : null;
  function readTheme() {
    const names = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);
    const parsed = TemplateThemeVars.safeParse({ primary: names(themeText.primary), primary_dark: names(themeText.primary_dark), secondary: names(themeText.secondary) });
    if (!parsed.success) {
      setThemeError("ชื่อตัวแปรไม่ถูกต้อง ใช้รูปแบบ --ชื่อ คั่นด้วยจุลภาค สูงสุด 8 ชื่อ (Invalid variable name: use --name, comma separated, at most 8)");
      return null;
    }
    setThemeError(null);
    return parsed.data;
  }
  function submitApprove() {
    const vars = readTheme();
    if (vars) onApprove(vars);
  }
  async function detectColors() {
    setThemeNote(null);
    setThemeError(null);
    setThemeBusy(true);
    try {
      const r = await api.detectTemplateThemeVars(t.template_version_id);
      if (isEmptyThemeVars(r.theme_vars)) {
        setThemeText({ primary: "", primary_dark: "", secondary: "" });
        setThemeNote({ kind: "info", text: "ไม่พบตัวแปรสี (No color variables found)" });
        return;
      }
      setThemeText({ primary: joinNames(r.theme_vars.primary), primary_dark: joinNames(r.theme_vars.primary_dark), secondary: joinNames(r.theme_vars.secondary) });
    } catch (e) {
      setThemeError(errorText(e));
    } finally {
      setThemeBusy(false);
    }
  }
  async function saveColors() {
    const vars = readTheme();
    if (!vars) return;
    setThemeNote(null);
    setThemeBusy(true);
    try {
      await api.saveTemplateThemeVars(t.template_version_id, vars);
    } catch (e) {
      setThemeError(errorText(e));
      setThemeBusy(false);
      return;
    }
    // The save is done; a failed reload shows its own error and leaves the note.
    setThemeNote({ kind: "ok", text: "บันทึกแล้ว Redeploy แบรนด์เพื่อให้สีมีผล (Saved. Redeploy brands to apply)" });
    try {
      await onSaved();
    } catch (e) {
      setThemeError(errorText(e));
    } finally {
      setThemeBusy(false);
    }
  }
  const savedLedger = detected && (
    <div className="ledger" style={{ marginBlock: 12 }}>
      {THEME_ROLES.map(([role, label]) => <div key={role} className="cell"><span className="k" style={{ display: "block" }}>{label}</span><b>{joinNames(detected[role]) || "-"}</b></div>)}
    </div>
  );
  const identity = detail.checks.find((c) => c.check_name === "identity_scan");
  const similarity = (identity?.details as { similarity?: { summary?: string } } | null | undefined)?.similarity?.summary ?? null;
  const defaults = t.text_defaults;
  const failures = similarityFailures(detail.checks);
  // Similarity lines show once, in the gate block, so the warning list leaves them out.
  const warnings = detail.checks.flatMap((c) => checkWarnings(c.details).filter((i) => ruleDisposition(i.rule) === "warn" && i.rule !== "similarity"));
  const importWarnings = detail.checks.flatMap((c) => checkWarnings(c.details, "import_warnings").filter((i) => i.rule !== "similarity"));
  return (
    <section className="tpl-detail" aria-label="รายละเอียดเทมเพลต">
      <div className="tpl-detail-head">
        <h2>{`${t.name} · v${t.version}`}</h2>
        <Chip tone={statusTone[t.status]} dot>{statusLabel[t.status]}</Chip>
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
      <SimilarityGate failures={failures} sealed={sealed} />
      <Warnings issues={[...warnings, ...importWarnings]} plain />
      {similarity && failures.length === 0 && <p className="hint">ความคล้าย (Similarity): {similarity}</p>}
      <h3>ข้อความเริ่มต้น (Text defaults)</h3>
      <div className="ledger" style={{ marginBlock: 12 }}>
        <div className="cell"><span className="k" style={{ display: "block" }}>ชื่อแบรนด์ (Brand name)</span><b>{defaults?.brand_name ?? "-"}</b></div>
        <div className="cell"><span className="k" style={{ display: "block" }}>ชื่อหน้า (Page title)</span><b>{defaults?.title ?? "-"}</b></div>
        <div className="cell"><span className="k" style={{ display: "block" }}>คำอธิบาย (Meta description)</span><b>{defaults?.description ?? "-"}</b></div>
      </div>
      <h3>ตัวแปรสี (Color variables)</h3>
      {editable && sealed && savedLedger}
      {editable ? (
        <div style={{ display: "grid", gap: 8, marginBlock: 12 }}>
          {THEME_ROLES.map(([role, label]) => (
            <label key={role}>{label}
              <input aria-label={label} placeholder="--brand-color, --accent" value={themeText[role]} onChange={(e) => setThemeText({ ...themeText, [role]: e.target.value })} />
            </label>
          ))}
          {themeError && <p className="note neg" role="alert">{themeError}</p>}
        </div>
      ) : detected ? savedLedger : <p className="hint">ไม่พบตัวแปรสี (No color variables found)</p>}
      {themeNote && <p className={themeNote.kind === "ok" ? "note pos" : "hint"} role="status">{themeNote.text}</p>}
      {editable && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={busy || themeBusy} onClick={() => void detectColors()}>ตรวจหาสี (Detect colors)</button>
          {sealed
            ? <button type="button" className="btn pri" disabled={busy || themeBusy} onClick={() => void saveColors()}>บันทึกแผนที่สี (Save color map)</button>
            : <button className="btn pri" disabled={busy || themeBusy || failures.length > 0} title={failures.length > 0 ? approveBlockedText(failures.length) : undefined} onClick={submitApprove}>อนุมัติ (Approve)</button>}
        </div>
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
