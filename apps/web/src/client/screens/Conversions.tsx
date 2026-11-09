import {
  BrandId, CONVERSIONS_MAX_LIMIT, CONVERSIONS_ROW_LIMIT, CONVERSION_STALLED_HOURS, CONVERSION_STATUSES, SPEND_PERIODS,
  type ConversionsReportResponse, type ConversionStatus, type SpendPeriod,
} from "@anjuna/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { BrandLabel, useBrandDomains } from "../brand-labels";
import { type Column, DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { FilterBar } from "../components/FilterBar";
import { LoadMore } from "../components/LoadMore";
import { Spinner } from "../components/Spinner";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { REASON_TEXT } from "../conversion-labels";
import { navigate, useSearch, viewPath } from "../router";
import "./Conversions.css";
import { useBrandScope } from "../useBrandScope";
import { AllBrandsNote } from "../components/AllBrandsNote";

type Row = ConversionsReportResponse["rows"][number];
export interface ConversionFilters { period: SpendPeriod; status: "all" | ConversionStatus; brand: string | null }

const DEFAULT_PERIOD: SpendPeriod = "7d";
const LIMIT_START = CONVERSIONS_ROW_LIMIT;
const LIMIT_STEP = CONVERSIONS_ROW_LIMIT;
const PERIOD_LABEL: Record<SpendPeriod, string> = { today: "วันนี้", yesterday: "เมื่อวาน", "7d": "7 วัน", "30d": "30 วัน" };
const STATUS_CHIPS: Array<[ConversionFilters["status"], string]> = [
  ["all", "ทั้งหมด"], ["pending", "ค้างส่ง (pending)"], ["processing", "กำลังส่ง (processing)"], ["uploaded", "ส่งแล้ว (uploaded)"], ["dead", "ส่งไม่ได้ (dead)"],
];
const STATUS_BADGE: Record<ConversionStatus, { tone: Tone; label: string }> = {
  uploaded: { tone: "live", label: "ส่งแล้ว" },
  pending: { tone: "blue", label: "ค้างส่ง" },
  processing: { tone: "mute", label: "กำลังส่ง" },
  dead: { tone: "bad", label: "ส่งไม่ได้" },
};
const COUNT_CELLS: Array<[keyof ConversionsReportResponse["totals"], string]> = [
  ["pending", "ค้างส่ง"], ["processing", "กำลังส่ง"], ["uploaded", "ส่งแล้ว"], ["dead", "ส่งไม่ได้"],
];

/** An unknown period or status reads as the default, and a brand that is not a brand id reads as none, so core never answers 422. */
export function readConversionFilters(search: string): ConversionFilters {
  const params = new URLSearchParams(search);
  const period = SPEND_PERIODS.find((value) => value === params.get("period")) ?? DEFAULT_PERIOD;
  const status = (["all", ...CONVERSION_STATUSES] as const).find((value) => value === params.get("status")) ?? "all";
  const brand = params.get("brand");
  return { period, status, brand: brand && BrandId.safeParse(brand).success ? brand : null };
}

/** Only the values that differ from the defaults, so the default view is a clean /conversions. */
export function conversionsPath(filters: ConversionFilters): string {
  const params = new URLSearchParams();
  if (filters.period !== DEFAULT_PERIOD) params.set("period", filters.period);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.brand) params.set("brand", filters.brand);
  const query = params.toString();
  return query ? `${viewPath("conversions")}?${query}` : viewPath("conversions");
}

const count = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("th-TH") : "—");

function Reason({ row }: { row: Row }) {
  const reason = row.reason_code ? REASON_TEXT[row.reason_code] : null;
  // An employee often gets null: core withholds free text that is not on its allow-list.
  const error = row.last_error?.trim() ? row.last_error : null;
  if (!reason && !error) return <>—</>;
  return (
    <div className="conv-reason">
      {reason && <><b>{reason.label}</b><p className="note">{reason.fix}</p></>}
      {error && <details><summary>ข้อความเต็ม</summary><code>{error}</code></details>}
    </div>
  );
}

type Load = { report: ConversionsReportResponse; limit: number } | { error: string } | null;

export function ConversionsScreen({ me }: { me: Me }) {
  const { inScopeId } = useBrandScope();
  const owner = me.role === "owner";
  const { period, status, brand } = readConversionFilters(useSearch());
  const domains = useBrandDomains();
  const [load, setLoad] = useState<Load>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  // The key ties the grown limit to the filters that grew it: a filter change reads as the start limit again.
  const filterKey = `${period}\n${status}\n${brand ?? ""}`;
  const [more, setMore] = useState({ key: filterKey, limit: LIMIT_START });
  const limit = more.key === filterKey ? more.limit : LIMIT_START;
  // Re-key during render on every filter change, so returning to an earlier filter never revives its grown limit.
  if (more.key !== filterKey) setMore({ key: filterKey, limit: LIMIT_START });
  // The limit of the report on screen. A failed Load more falls back to it so a retry works.
  // loadedKey names the filters it was loaded for: only the pair together may skip a request, so the
  // StrictMode second run still fetches while the first answer is dropped by its cleanup.
  const loadedLimit = useRef(LIMIT_START);
  const loadedKey = useRef<string | null>(null);
  // A limit-only change keeps the table on screen; anything else falls back to the spinner.
  const lastBaseKey = useRef<string | null>(null);

  // A late answer for old filters or an old limit is dropped.
  useEffect(() => {
    let current = true;
    if (lastBaseKey.current !== filterKey) {
      lastBaseKey.current = filterKey;
      loadedLimit.current = LIMIT_START;
      loadedKey.current = null;
      setLoad(null);
      setLoadMoreError(null);
    } else if (loadedKey.current === filterKey && limit === loadedLimit.current) {
      // A failed Load more fell back to the loaded limit: the rows already shown are the answer.
      return () => { current = false; };
    }
    const growing = loadedKey.current === filterKey && limit !== loadedLimit.current;
    api.conversions({ period, status: status === "all" ? undefined : status, brand: brand ?? undefined, limit }).then(
      (report) => {
        if (!current) return;
        loadedKey.current = filterKey;
        loadedLimit.current = limit;
        setLoad({ report, limit });
        setLoadMoreError(null);
      },
      (e: unknown) => {
        if (!current) return;
        const message = e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ";
        if (growing) {
          // A failed Load more keeps the rows, shows the error by the button and falls back so a retry works.
          setLoadMoreError(message);
          setMore({ key: filterKey, limit: loadedLimit.current });
        } else {
          setLoad({ error: message });
        }
      },
    );
    return () => { current = false; };
  }, [period, status, brand, limit, filterKey]);

  // Rows picked for a bulk resend. Only dead rows can be picked; a filter change clears the pick.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { setPicked(new Set()); }, [filterKey]);
  const togglePick = (id: string) => setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  // replace: a filter click edits the open page and adds no history entry.
  const change = (patch: Partial<ConversionFilters>) => navigate(conversionsPath({ period, status, brand, ...patch }), { replace: true });
  const labelOf = (id: string) => domains.get(id) ?? id;
  const options = [...domains].map(([id, domain]) => ({ id, text: domain === id ? id : `${domain} (${id})` })).sort((a, b) => a.text.localeCompare(b.text));

  const visibleRows = useMemo(() => (load && "report" in load ? load.report.rows.filter((row) => inScopeId(row.brand)) : []), [load, inScopeId]);
  const deadIds = visibleRows.filter((row) => row.status === "dead").map((row) => row.lead_id);
  const allDeadPicked = deadIds.length > 0 && deadIds.every((id) => picked.has(id));
  const columns: Column<Row>[] = [
    ...(owner ? [{
      key: "pick",
      header: <input type="checkbox" aria-label="เลือกทุกรายการที่ส่งไม่ได้" checked={allDeadPicked} disabled={deadIds.length === 0} onChange={() => setPicked(allDeadPicked ? new Set() : new Set(deadIds))} />,
      label: "",
      cell: (row: Row) => (row.status === "dead"
        ? <input type="checkbox" aria-label={`เลือก ${row.lead_id.slice(0, 8)}`} checked={picked.has(row.lead_id)} onChange={() => togglePick(row.lead_id)} />
        : null),
    }] : []),
    { key: "brand", header: "แบรนด์", cell: (row) => <BrandLabel brandId={row.brand} domain={labelOf(row.brand)} /> },
    { key: "status", header: "สถานะ", cell: (row) => <StatusBadge {...STATUS_BADGE[row.status]} /> },
    { key: "reason", header: "เหตุผล", cell: (row) => <Reason row={row} /> },
    { key: "click", header: "Click", mono: true, cell: (row) => row.click_type ?? "—" },
    { key: "attempts", header: "ครั้งที่ลอง", align: "right", cell: (row) => count(row.attempts) },
    // The column follows the role. A number that arrives for an employee is not shown.
    ...(owner ? [{ key: "value", header: "มูลค่า (Value)", align: "right" as const, cell: (row: Row) => (row.value === null ? "—" : usd(row.value)) }] : []),
    { key: "created", header: "สร้างเมื่อ", cell: (row) => when(row.created_at) },
    { key: "next", header: "ลองใหม่", cell: (row) => when(row.next_attempt_at) },
  ];
  const report = load && "report" in load ? load.report : null;
  const loadingMore = load !== null && "report" in load && load.limit !== limit;
  const shownLimit = load && "report" in load ? load.limit : LIMIT_START;
  const loadMore = () => {
    if (loadingMore || !report?.truncated || limit >= CONVERSIONS_MAX_LIMIT) return;
    setMore({ key: filterKey, limit: Math.min(CONVERSIONS_MAX_LIMIT, limit + LIMIT_STEP) });
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>คอนเวอร์ชัน</h1>
          <p className="sub">ลีดที่ขายได้และผลการส่งขึ้น Google Ads / Microsoft Ads (ดูอย่างเดียว)</p>
        </div>
        <div className="seg" role="group" aria-label="ช่วงเวลา">
          {SPEND_PERIODS.map((key) => (
            <button key={key} type="button" aria-pressed={period === key} onClick={() => change({ period: key })}>{PERIOD_LABEL[key]}</button>
          ))}
        </div>
      </div>
      <FilterBar label="ตัวกรองคอนเวอร์ชัน (Conversion filters)" activeCount={(status !== "all" ? 1 : 0) + (brand ? 1 : 0)}>
      <div className="conv-filters">
        <div className="conv-chips" role="group" aria-label="สถานะ">
          {STATUS_CHIPS.map(([key, label]) => {
            // The totals cover the period and the brand, whatever status is chosen.
            const totals = load && "report" in load ? load.report.totals : null;
            const n = totals ? (key === "all" ? totals.pending + totals.processing + totals.uploaded + totals.dead : totals[key]) : null;
            return (
              <button key={key} type="button" aria-pressed={status === key} aria-label={label} onClick={() => change({ status: key })}>
                {label}{n !== null && <span className="num">{count(n)}</span>}
              </button>
            );
          })}
        </div>
        <select aria-label="แบรนด์" value={brand ?? ""} onChange={(e) => change({ brand: e.target.value || null })}>
          <option value="">ทุกแบรนด์</option>
          {brand && !domains.has(brand) && <option value={brand}>{brand}</option>}
          {options.map((option) => <option key={option.id} value={option.id}>{option.text}</option>)}
        </select>
      </div>
      </FilterBar>
      {!load && <Spinner />}
      {load && "error" in load && <p role="alert">{load.error}</p>}
      {report && (
        <div className="conv-stack">
          <AllBrandsNote>ยอดสรุปด้านล่างนับทุกแบรนด์ ส่วนตารางตามขอบเขตแบรนด์</AllBrandsNote>
          <div className="ledger conv-stats" role="group" aria-label="สรุปคอนเวอร์ชัน">
            {COUNT_CELLS.map(([key, label]) => (
              <div className="cell" key={key}><p className="k">{label}</p><p className={key === "dead" && report.totals.dead > 0 ? "v neg" : "v"}>{count(report.totals[key])}</p></div>
            ))}
            {report.stalled > 0 && (
              <div className="cell"><p className="k">ติดค้างนาน</p><p className="v"><StatusBadge tone="warn" label={`ค้างเกิน ${CONVERSION_STALLED_HOURS} ชม. ${count(report.stalled)}`} /></p></div>
            )}
            {owner && (
              <>
                <div className="cell"><p className="k">มูลค่าที่ส่งแล้ว</p><p className="v">{report.value_totals ? usd(report.value_totals.uploaded) : "—"}</p></div>
                <div className="cell"><p className="k">มูลค่าที่ส่งไม่ได้</p><p className="v">{report.value_totals ? usd(report.value_totals.dead) : "—"}</p></div>
              </>
            )}
          </div>
          <section className="panel" aria-label="รายการคอนเวอร์ชัน">
            <h2>คิวคอนเวอร์ชัน</h2>
            {owner && picked.size > 0 && (
              <div className="conv-bulk" role="toolbar" aria-label="จัดการรายการที่เลือก">
                <span className="num">เลือก {count(picked.size)} รายการ</span>
                <button type="button" className="btn" disabled title="ยังไม่มีเส้นทางส่งใหม่ที่ฝั่งเซิร์ฟเวอร์ ปุ่มจะใช้ได้เมื่อมี">ส่งใหม่ {count(picked.size)} รายการ</button>
                <span className="hint">ส่งใหม่ยังใช้ไม่ได้ ยังไม่มีเส้นทางส่งใหม่ที่ฝั่งเซิร์ฟเวอร์</span>
                <button type="button" className="btn conv-bulk-clear" aria-label="ล้างการเลือก" onClick={() => setPicked(new Set())}>ล้าง</button>
              </div>
            )}
            <DataTable
              label="รายการคอนเวอร์ชัน (Conversions)"
              columns={columns}
              rows={visibleRows}
              rowKey={(row) => row.lead_id}
              empty={<EmptyState title="ยังไม่มีคอนเวอร์ชันในช่วงนี้" />}
            />
            {loadMoreError && <p role="alert">{loadMoreError}</p>}
            <LoadMore shown={visibleRows.length} hasMore={report.truncated} atMax={shownLimit >= CONVERSIONS_MAX_LIMIT} loading={loadingMore} onMore={loadMore} narrowHint="กรุณากรองให้แคบลง (Narrow the filters)" />
          </section>
        </div>
      )}
    </>
  );
}
