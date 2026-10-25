// spec traffic
import { BrandId, CLIENT_ERROR_TYPES_LIMIT, TRAFFIC_LOG_PERIODS, type ClientErrorsResponse, type TrafficLogPeriod } from "@anjuna/contracts";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { BrandLabel, useBrandDomains } from "../brand-labels";
import { type Column, DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { navigate, useSearch } from "../router";
import "./Traffic.css";

type Row = ClientErrorsResponse["rows"][number];
export interface ClientErrorFilters { period: TrafficLogPeriod; brand: string | null; type: string | null }

const DEFAULT_PERIOD: TrafficLogPeriod = "24h";
const TYPE_MAX = 64;
const PERIOD_LABEL: Record<TrafficLogPeriod, string> = { "24h": "24 ชม. (24h)", "7d": "7 วัน (7d)", "30d": "30 วัน (30d)" };

/** An unknown period reads as the default; a brand that is not a brand id and an empty or over-long type read as none, so core never answers 422. */
export function readClientErrorFilters(search: string): ClientErrorFilters {
  const params = new URLSearchParams(search);
  const period = TRAFFIC_LOG_PERIODS.find((value) => value === params.get("period")) ?? DEFAULT_PERIOD;
  const brand = params.get("brand");
  const type = params.get("type");
  return {
    period,
    brand: brand && BrandId.safeParse(brand).success ? brand : null,
    type: type && type.length <= TYPE_MAX ? type : null,
  };
}

/** Only the values that differ from the defaults, so the default view is a clean /errors. */
export function clientErrorsPath(filters: ClientErrorFilters): string {
  const params = new URLSearchParams();
  if (filters.period !== DEFAULT_PERIOD) params.set("period", filters.period);
  if (filters.brand) params.set("brand", filters.brand);
  if (filters.type) params.set("type", filters.type);
  const query = params.toString();
  return query ? `/errors?${query}` : "/errors";
}

const count = (n: number) => n.toLocaleString("en-US");

type Counts = ClientErrorsResponse["counts"];
type Loaded = { rows: Row[]; next: string | null };
type Load = Loaded | { error: string } | null;

export function ClientErrorsScreen({ me }: { me: Me }) {
  const owner = me.role === "owner";
  const { period, brand, type } = readClientErrorFilters(useSearch());
  const domains = useBrandDomains();
  const [load, setLoad] = useState<Load>(null);
  // Counts ignore the type filter in core, so they outlive a type change (and a failed request) and belong to one period and brand.
  const [counted, setCounted] = useState<{ key: string; counts: Counts } | null>(null);
  const countsKey = `${period}|${brand ?? ""}`;
  const counts = counted && counted.key === countsKey ? counted.counts : null;
  const [attempt, setAttempt] = useState(0);
  const [paging, setPaging] = useState<"idle" | "busy" | "failed">("idle");
  // Bumped on every filter change, so a page that arrives for old filters is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setLoad(null);
    setPaging("idle");
    api.clientErrors({ period, brand_id: brand ?? undefined, error_type: type ?? undefined }).then(
      (page) => {
        if (generation.current !== mine) return;
        setCounted({ key: `${period}|${brand ?? ""}`, counts: page.counts });
        setLoad({ rows: page.rows, next: page.next_cursor });
      },
      (e: unknown) => { if (generation.current === mine) setLoad({ error: e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ" }); },
    );
    return () => { generation.current += 1; };
  }, [period, brand, type, attempt]);

  const loadMore = () => {
    if (!load || "error" in load || !load.next || paging === "busy") return;
    const mine = generation.current;
    setPaging("busy");
    api.clientErrors({ period, brand_id: brand ?? undefined, error_type: type ?? undefined, cursor: load.next }).then(
      (page) => {
        if (generation.current !== mine) return;
        setLoad((prev) => (prev && !("error" in prev) ? { ...prev, rows: [...prev.rows, ...page.rows], next: page.next_cursor } : prev));
        setPaging("idle");
      },
      () => { if (generation.current === mine) setPaging("failed"); },
    );
  };

  // replace: a filter click edits the open page and adds no history entry.
  const change = (patch: Partial<ClientErrorFilters>) => navigate(clientErrorsPath({ period, brand, type, ...patch }), { replace: true });
  const labelOf = (id: string) => domains.get(id) ?? id;
  const options = [...domains].map(([id, domain]) => ({ id, text: domain === id ? id : `${domain} (${id})` })).sort((a, b) => a.text.localeCompare(b.text));

  const columns: Column<Row>[] = [
    // The stored client text, not a parsed date.
    { key: "at", header: "เวลา (UTC)", cell: (row) => row.occurred_at },
    { key: "type", header: "ประเภท", mono: true, cell: (row) => row.error_type },
    { key: "brand", header: "แบรนด์", cell: (row) => (row.brand_id ? <BrandLabel brandId={row.brand_id} domain={labelOf(row.brand_id)} /> : "—") },
    { key: "screen", header: "หน้าจอ", cell: (row) => row.screen_id ?? "—" },
    { key: "ref", header: "เซสชัน (Session ref)", mono: true, cell: (row) => row.session_ref ?? "—" },
    {
      key: "message",
      header: "ข้อความ",
      cell: (row) => {
        if (row.error_message === null && !owner) return "— (Owner only)";
        return row.error_message?.trim() ? <span className="ce-message">{row.error_message}</span> : "—";
      },
    },
  ];

  const loaded = load && !("error" in load) ? load : null;
  const chips = counts ? [...counts] : [];
  // A selected type stays visible even when the current brand has none of it.
  if (counts && type && !chips.some((chip) => chip.error_type === type)) chips.push({ error_type: type, count: 0 });
  // Past the types cap the sum would undercount, so the "all" chip then shows no number.
  const total = counts && counts.length < CLIENT_ERROR_TYPES_LIMIT ? chips.reduce((sum, chip) => sum + chip.count, 0) : null;

  return (
    <div className="ce-page">
      <div className="head">
        <div>
          <h1>ข้อผิดพลาดฝั่งเว็บ</h1>
          <p className="sub">ข้อผิดพลาดที่ฟอร์มรายงานจากเบราว์เซอร์ของผู้เข้าชม (ดูอย่างเดียว)</p>
        </div>
        <div className="seg" role="group" aria-label="ช่วงเวลา">
          {TRAFFIC_LOG_PERIODS.map((key) => (
            <button key={key} type="button" aria-pressed={period === key} onClick={() => change({ period: key })}>{PERIOD_LABEL[key]}</button>
          ))}
        </div>
      </div>
      <div className="ce-filters">
        <div className="ce-chips" role="group" aria-label="ประเภท">
          <button type="button" aria-pressed={type === null} onClick={() => change({ type: null })}>
            ทั้งหมด{total !== null && <>{" "}<span className="ce-count">{count(total)}</span></>}
          </button>
          {chips.map((chip) => (
            <button key={chip.error_type} type="button" aria-pressed={type === chip.error_type} onClick={() => change({ type: chip.error_type })}>
              {chip.error_type} <span className="ce-count">{count(chip.count)}</span>
            </button>
          ))}
        </div>
        <select aria-label="แบรนด์" value={brand ?? ""} onChange={(e) => change({ brand: e.target.value || null })}>
          <option value="">ทุกแบรนด์</option>
          {brand && !domains.has(brand) && <option value={brand}>{brand}</option>}
          {options.map((option) => <option key={option.id} value={option.id}>{option.text}</option>)}
        </select>
      </div>
      {!load && <Spinner />}
      {load && "error" in load && (
        <div className="note neg ce-error" role="alert">
          <p>{load.error}</p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>ลองอีกครั้ง</button>
        </div>
      )}
      {loaded && (
        <section className="panel" aria-label="ข้อผิดพลาดฝั่งเว็บ">
          <DataTable
            label="ข้อผิดพลาดฝั่งเว็บ (Client errors)"
            columns={columns}
            rows={loaded.rows}
            rowKey={(row) => String(row.id)}
            empty={<EmptyState title="ไม่มีข้อผิดพลาดในช่วงนี้" />}
          />
          {paging === "failed" && <p className="note neg ce-error" role="alert">โหลดเพิ่มไม่สำเร็จ</p>}
          {loaded.next && (
            <div className="ce-more">
              <button type="button" className="btn" disabled={paging === "busy"} onClick={loadMore}>โหลดเพิ่ม (Load more)</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
