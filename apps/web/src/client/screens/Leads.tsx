import { LEAD_AGGREGATES_MAX_DAYS, LEAD_OUTCOMES, type LeadListRow, type LeadOutcome, LeadsQuery, type LeadsResponse } from "@anjuna/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, api, type LeadFilterState, type Me } from "../api";
import { BrandLabel, buildBrandLabels } from "../brand-labels";
import { CsvButton } from "../components/CsvButton";
import { DataTable, type Column } from "../components/DataTable";
import type { CsvColumn } from "../csv";
import { FilterBar } from "../components/FilterBar";
import { useConfirm } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { isPlainLeftClick, navigate, routePath } from "../router";
import { useBrandScope } from "../useBrandScope";
import { LeadDetailScreen } from "./LeadDetail";
import "./Leads.css";

// spec leads
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const outcomes: Array<[LeadOutcome, string, Tone]> = [
  ["sold", "ขายได้ (Sold)", "live"],
  ["pending", "รอผล (Pending)", "blue"],
  ["rejected", "ถูกปฏิเสธ (Rejected)", "bad"],
];
const message = (e: unknown) => e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ";
const fmt = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });

/** The last 30 days in UTC, the window core resolves when a bound is missing. */
function defaultWindow(now = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  return { to, from: new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10) };
}

function filterFromUrl(search: string): LeadFilterState {
  const params = new URLSearchParams(search);
  const window = defaultWindow();
  const status = params.get("status");
  const from = params.get("from");
  const to = params.get("to");
  return {
    from: from && DAY.test(from) ? from : window.from,
    to: to && DAY.test(to) ? to : window.to,
    brand: params.get("brand") ?? "",
    status: (LEAD_OUTCOMES as readonly string[]).includes(status ?? "") ? status as LeadOutcome : "",
    q: params.get("q") ?? "",
  };
}

/** The filter goes to the query string; an open lead stays in the path so the panel stays open. */
function writeFilter(filter: LeadFilterState, leadId: string | null): void {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "brand", "status", "q"] as const) if (filter[key]) params.set(key, filter[key]);
  const query = params.toString();
  const path = routePath({ view: "leads", leadId });
  navigate(query ? `${path}?${query}` : path, { replace: true });
}

const RANGES: Array<[number, string]> = [[1, "วันนี้"], [7, "7 วัน"], [30, "30 วัน"]];
/** The window of the last `days` days in UTC, ending today. */
function windowOf(days: number, now = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  return { to, from: new Date(Date.parse(to) - (days - 1) * 86_400_000).toISOString().slice(0, 10) };
}

/** Why core would refuse this filter, checked with the contract's own LeadsQuery. Empty when the filter is valid. */
function filterProblems(filter: LeadFilterState): string[] {
  const parsed = LeadsQuery.safeParse(Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== "")));
  if (parsed.success) return [];
  return [...new Set(parsed.error.issues.map((issue) => {
    const field = String(issue.path[0] ?? "");
    if (field === "q") return "คำค้นต้องเป็นรหัสลีดหรือ click id ยาว 4 ถึง 64 ตัว ใช้ได้เฉพาะ A-Z a-z 0-9 และ - (Search needs 4 to 64 letters, digits or hyphens)";
    if (field === "brand") return "รหัสแบรนด์ไม่ถูกต้อง (Invalid brand ID)";
    if (field === "from" || field === "to") return "วันที่ไม่ถูกต้อง (Invalid date)";
    if (field === "status") return "สถานะไม่ถูกต้อง (Invalid status)";
    return filter.from > filter.to
      ? `วันเริ่มต้องไม่อยู่หลังวันสิ้นสุด (${issue.message})`
      : `ช่วงวันที่ยาวเกิน ${LEAD_AGGREGATES_MAX_DAYS} วัน (${issue.message})`;
  }))];
}

/** The same rules and tones as the detail screen's reconciliation line; the first match wins. */
function Reconciliation({ row }: { row: LeadListRow }) {
  if (row.has_conversion) return <StatusBadge tone="live" label="มี conversion (Has conversion)" />;
  if (row.outcome === "sold") return <StatusBadge tone="bad" label="ขายแล้วแต่ไม่มีรายการอัปโหลด (Sold, no upload)" />;
  if (row.postback_count === 0) return <StatusBadge tone="warn" label="ยังไม่มี postback (No postback yet)" />;
  return <StatusBadge tone="blue" label="มี postback (Postback received)" />;
}

export function LeadsScreen({ me, selectedId = null, onSelect, onClose }: { me: Me; selectedId?: string | null; onSelect: (id: string) => void; onClose?: () => void }) {
  const [filter, setFilter] = useState<LeadFilterState>(() => filterFromUrl(window.location.search));
  const [qDraft, setQDraft] = useState(filter.q);
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<LeadsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [domains, setDomains] = useState(() => new Map<string, string>());
  const [confirm, confirmDialog] = useConfirm();
  const owner = me.role === "owner";
  const problems = filterProblems(filter);
  const valid = problems.length === 0;

  useEffect(() => {
    let active = true;
    void Promise.allSettled([api.lifecycleBrands(), api.brands()]).then(([lifecycle, runtime]) => {
      if (!active) return;
      setDomains(buildBrandLabels(lifecycle.status === "fulfilled" ? lifecycle.value.brands : null, runtime.status === "fulfilled" ? runtime.value.brands : null));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setPage(null); setError(null);
    if (filterProblems(filter).length > 0) return;
    api.leads(filter, cursor).then(
      (next) => { if (active) setPage(next); },
      (e: unknown) => { if (active) setError(message(e)); },
    );
    return () => { active = false; };
  }, [filter, cursor]);

  // Any filter change starts again at page 1; the cursor never reaches the URL.
  const update = (patch: Partial<LeadFilterState>) => {
    const next = { ...filter, ...patch };
    setFilter(next);
    setCursor(null);
    writeFilter(next, selectedId);
  };
  const search = (e: FormEvent) => { e.preventDefault(); if (qDraft !== filter.q) update({ q: qDraft }); };

  // A button, not a link: a middle click or "Save link as" would follow a PII href without the dialog.
  // After Confirm a link made only for this click downloads with the session cookie, then goes away.
  const downloadPii = async () => {
    const url = api.leadsExportUrl(filter, true);
    const ok = await confirm({
      title: "ดาวน์โหลด CSV พร้อมข้อมูลส่วนตัว (Download CSV with PII)",
      body: <p>ไฟล์มีชื่อ อีเมล เบอร์โทร ที่อยู่ และวันเกิดของผู้สมัคร การดาวน์โหลดนี้ถูกบันทึกในบันทึกการตรวจสอบ (audit log) พร้อมชื่อของคุณ (The file holds applicant names, emails, phones, addresses and birth dates. This download is recorded in the audit log under your name.)</p>,
      confirmLabel: "ดาวน์โหลด (Download)",
    });
    if (!ok) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  // The brand scope decides which leads and which brand choices show (PLAN A9). The chosen filter brand always stays in the list.
  const { inScopeId } = useBrandScope();
  const brandOptions = new Map([...domains].filter(([id]) => inScopeId(id) || id === filter.brand));
  if (filter.brand && !brandOptions.has(filter.brand)) brandOptions.set(filter.brand, filter.brand);
  const outcomeTone = new Map(outcomes.map(([value, label, tone]) => [value, { label, tone }]));

  // The CSV of the rows on screen: the same columns as the table, with no email or phone (those only come with the server export).
  const csvColumns: CsvColumn<LeadListRow>[] = [
    { header: "สร้างเมื่อ", value: (r) => r.created_at },
    { header: "แบรนด์", value: (r) => r.brand },
    { header: "ผล", value: (r) => outcomeTone.get(r.outcome)?.label ?? r.outcome },
    { header: "ยอดที่ขอ", value: (r) => r.requested_amount },
    { header: "รัฐ", value: (r) => r.state },
    { header: "คีย์เวิร์ด", value: (r) => r.keyword },
    { header: "ตัวแปร", value: (r) => r.variant },
    { header: "รหัสลีด", value: (r) => r.lead_id },
  ];
  const columns: Column<LeadListRow>[] = [
    { key: "created", header: "สร้างเมื่อ (Created)", cell: (r) => fmt(r.created_at) },
    { key: "brand", header: "แบรนด์ (Brand)", cell: (r) => <BrandLabel brandId={r.brand} domain={domains.get(r.brand) ?? r.hostname} /> },
    { key: "outcome", header: "ผล (Outcome)", cell: (r) => { const o = outcomeTone.get(r.outcome)!; return <StatusBadge tone={o.tone} label={o.label} />; } },
    { key: "amount", header: "ยอดที่ขอ (Amount)", cell: (r) => `$${r.requested_amount.toLocaleString("en-US")}`, align: "right" },
    { key: "state", header: "รัฐ (State)", cell: (r) => r.state },
    { key: "keyword", header: "คีย์เวิร์ด (Keyword)", cell: (r) => r.keyword ?? "" },
    { key: "variant", header: "ตัวแปร (Variant)", cell: (r) => r.variant ?? "" },
    { key: "reconciliation", header: "ตรวจยอด (Reconciliation)", cell: (r) => <Reconciliation row={r} /> },
    {
      key: "lead",
      header: "รหัสลีด (Lead ID)",
      mono: true,
      cell: (r) => (
        <a href={routePath({ view: "leads", leadId: r.lead_id })} title={r.lead_id} aria-current={r.lead_id === selectedId ? "true" : undefined}
          onClick={(e) => { if (!isPlainLeftClick(e)) return; e.preventDefault(); onSelect(r.lead_id); }}>{r.lead_id.slice(0, 8)}…</a>
      ),
    },
    {
      key: "open",
      header: <span className="sr-only">ดูรายละเอียด</span>,
      label: "",
      cell: (r) => <button type="button" className="btn" aria-label={`ดูรายละเอียดลีด ${r.lead_id.slice(0, 8)}`} onClick={() => onSelect(r.lead_id)}>ดูรายละเอียด</button>,
    },
  ];

  const filtered = Boolean(filter.brand || filter.status || filter.q);
  const defaults = defaultWindow();
  const rangeActive = filter.from !== defaults.from || filter.to !== defaults.to ? 1 : 0;
  const empty = filtered
    ? <EmptyState title="ไม่พบลีดที่ตรงกับตัวกรอง (No leads match this filter)" hint="ลองเปลี่ยนแบรนด์ สถานะ หรือคำค้น (Try another brand, status or search)" />
    : <EmptyState title="ยังไม่มีลีดในช่วงนี้ (No leads in this window)" hint="ลองขยายช่วงวันที่ (Try a wider date range)" />;

  return <>
    <div className="head" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <div><h1>ลีด (Leads)</h1><p className="sub">ดูลีดทุกรายการ สถานะการขาย และตรวจว่า conversion ครบ (Every lead, its sale status and whether its conversion exists)</p></div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        {valid
          ? <a className="btn" href={api.leadsExportUrl(filter, false)} download>ดาวน์โหลด CSV</a>
          : <button type="button" className="btn" disabled>ดาวน์โหลด CSV</button>}
        {owner && <button type="button" className="btn" disabled={!valid} onClick={() => { void downloadPii(); }}>ดาวน์โหลด CSV พร้อม PII</button>}
      </div>
    </div>
    <section className="panel" aria-label="ตัวกรองลีด (Lead filters)">
      <FilterBar label="ตัวกรองลีด (Lead filters)" activeCount={[filter.brand, filter.status, filter.q].filter(Boolean).length + rangeActive}>
      <div className="leads-filters">
      <div className="filter-chips" role="group" aria-label="สถานะ">
        {([["", "ทั้งหมด"], ...outcomes.map(([value, label]) => [value, label.replace(/ \(.*\)$/, "")] as [string, string])] as Array<[LeadOutcome | "", string]>).map(([value, label]) => {
          const shown = page ? page.rows.filter((r) => inScopeId(r.brand)) : null;
          // The server filters by status, so only the loaded rows can be counted: the exact count of an open chip, the loaded rows of "ทั้งหมด" by outcome.
          const n = shown ? (filter.status === "" ? (value === "" ? shown.length : shown.filter((r) => r.outcome === value).length) : value === filter.status ? shown.length : null) : null;
          return (
            <button key={value || "all"} type="button" aria-pressed={filter.status === value} onClick={() => update({ status: value })}>
              {label}{n !== null && <span className="num">{n}{page?.next_cursor && (filter.status === "" || value === filter.status) ? "+" : ""}</span>}
            </button>
          );
        })}
      </div>
      <form onSubmit={search} className="leads-toolbar">
        <label>แบรนด์ (Brand)
          <select value={filter.brand} onChange={(e) => update({ brand: e.target.value })}>
            <option value="">ทุกแบรนด์ (All brands)</option>
            {[...brandOptions].map(([id, domain]) => <option key={id} value={id}>{domain}</option>)}
          </select>
        </label>
        <label>ตั้งแต่ (From)
          <input type="date" value={filter.from} onChange={(e) => update({ from: e.target.value || defaultWindow().from })} />
        </label>
        <label>ถึง (To)
          <input type="date" value={filter.to} onChange={(e) => update({ to: e.target.value || defaultWindow().to })} />
        </label>
        <label>ค้นหา (Search)
          <input type="search" value={qDraft} placeholder="รหัสลีด 4 ตัวขึ้นไป (Lead ID prefix)" onChange={(e) => setQDraft(e.target.value)} />
        </label>
        <button type="submit" className="btn" style={{ marginBottom: 8 }}>ค้นหา (Search)</button>
        <div className="range-toggle" role="group" aria-label="ช่วงเวลา">
          {RANGES.map(([days, label]) => {
            const w = windowOf(days);
            return <button key={days} type="button" aria-pressed={filter.from === w.from && filter.to === w.to} onClick={() => update(w)}>{label}</button>;
          })}
        </div>
      </form>
      </div>
      </FilterBar>
      {problems.map((problem) => <p key={problem} role="alert" className="hint">{problem}</p>)}
      <p className="hint">ช่วงวันที่เป็น UTC ค่าเริ่มต้นคือ 30 วันล่าสุด · ค้นด้วยรหัสลีดหรือ click id เท่านั้น ไม่ค้นด้วยอีเมลหรือเบอร์โทร (Dates are UTC; search matches lead ID or click ID only)</p>
    </section>
    <div className={selectedId ? "leads-layout has-panel" : "leads-layout"}>
    <section className="panel" aria-label="รายการลีด">
      {!valid ? <p className="hint">แก้ตัวกรองด้านบนก่อนจึงจะโหลดรายการได้ (Fix the filter above to load the list)</p>
        : error ? <p role="alert">{error}</p> : !page ? <Spinner /> : <>
        <div className="csv-row"><CsvButton page="leads" columns={csvColumns} rows={page.rows.filter((r) => inScopeId(r.brand))} /></div>
        <DataTable label="รายการลีด" columns={columns} rows={page.rows.filter((r) => inScopeId(r.brand))} rowKey={(r) => r.lead_id} empty={empty} />
        {page.next_cursor && <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={() => setCursor(page.next_cursor)}>ถัดไป (Next)</button></div>}
      </>}
    </section>
    {selectedId && <LeadDetailScreen key={selectedId} me={me} leadId={selectedId} panel onBack={() => (onClose ?? (() => undefined))()} />}
    </div>
    {confirmDialog}
  </>;
}
