import type { DeployEvent, DeployHistoryQuery, DeploySource, DeployStatus, DeployUnavailableSource, InstallWithReceipts, LifecycleBrandSummary } from "@anjuna/contracts";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { BrandLabel, useBrandLabels } from "../brand-labels";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { InstallProgress } from "../components/InstallProgress";
import { LoadMore } from "../components/LoadMore";
import { Spinner } from "../components/Spinner";
import { StatusBadge } from "../components/StatusBadge";
import { operationLabel, statusBadgeTone, statusLabel } from "../labels";
import { isPlainLeftClick, navigate } from "../router";
import "./Deploys.css";

const SOURCES: ReadonlyArray<{ value: DeploySource; label: string }> = [
  { value: "install", label: "การติดตั้ง (Install)" },
  { value: "audit", label: "ประวัติการแก้ไข (Audit)" },
];
// The install states plus `done`, which is the only status an audit row carries.
const STATUSES: readonly DeployStatus[] = ["queued", "running", "ready", "failed", "rolled_back", "done"];

// spec polish D3.1: Load more grows the window from 50 to the server's cap of 200.
const LIMIT_START = 50;
const LIMIT_STEP = 50;
const LIMIT_MAX = 200;

/** What the feed says about each source it could not read. Exhaustive, so a new source id must write its own note. */
const UNAVAILABLE_NOTE: Record<DeployUnavailableSource, string> = {
  core_audit: "ไทม์ไลน์ไม่ครบ: อ่านประวัติจาก Core ไม่ได้ (core_audit) การแก้ไขค่าของแบรนด์ที่ Core บันทึกอยู่อาจหายไป (Part of the timeline is missing: the core audit source is unavailable.)",
};

const fmtTime = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });

/** `finished_at − started_at`, or an em dash while the row is unfinished. */
function fmtDuration(startedAt: string, finishedAt: string | null): string {
  if (finishedAt === null) return "—";
  const seconds = Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${seconds} วิ (${seconds}s)`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes} นาที (${minutes}m)` : `${minutes} นาที ${seconds % 60} วิ (${minutes}m ${seconds % 60}s)`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} ชม. (${hours}h)` : `${hours} ชม. ${minutes % 60} นาที (${hours}h ${minutes % 60}m)`;
}

/** owner / employee / system, read the way the audit log reads them. */
const actorRole = (role: DeployEvent["started_role"]): string => (role === "owner" ? "Owner" : role === "employee" ? "พนักงาน" : role);

/** The operation label of an install row, or the action of an audit row. */
const rowWhat = (event: DeployEvent): string => (event.operation ? operationLabel[event.operation] : event.action ?? "—");

/** The id of the one detail region a row's expand control points at. */
const detailRegionId = (eventId: string) => `deploy-detail-${eventId}`;

/** The id of the visible head that names the region, so the name carries the time the head shows. */
const detailHeadId = (eventId: string) => `deploy-detail-head-${eventId}`;

/** The receipts of an install row, or an audit row's action, actor, time and link to the audit log; an audit row costs no second request. */
function EventDetail({ event, detail, error }: { event: DeployEvent; detail: InstallWithReceipts | undefined; error: string | undefined }) {
  if (event.source === "audit") {
    return <div className="deploy-detail deploy-audit"><dl>
      <div><dt>การทำงาน (Action)</dt><dd><code>{event.action ?? "—"}</code></dd></div>
      <div><dt>ผู้เริ่ม (Actor)</dt><dd>{event.started_by} · {actorRole(event.started_role)}</dd></div>
      <div><dt>เวลาเริ่ม (Started at)</dt><dd><time dateTime={event.started_at}>{event.started_at}</time></dd></div>
    </dl>
    <p className="hint">ไทม์ไลน์นี้ไม่ส่งค่าก่อน/หลังของการแก้ไข ดูค่าก่อน/หลังได้ที่<a href="/audit" onClick={(e) => { if (!isPlainLeftClick(e)) return; e.preventDefault(); navigate("/audit"); }}>ประวัติการแก้ไข (audit log)</a> (This feed carries no before/after values.)</p>
  </div>;
  }
  return <div className="deploy-detail">
    {event.is_canary && <p className="hint">การติดตั้งนี้เป็น canary (Canary install)</p>}
    {/* A stored error is history; only the live load failure below is an alert. */}
    {event.error && <p className="error">{event.error}</p>}
    {detail
      ? <InstallProgress install={detail} canRetry={false} onRetry={() => undefined} />
      : error ? <p className="error" role="alert">{error}</p> : <p className="hint">กำลังโหลดรายละเอียด (Loading details)…</p>}
  </div>;
}

export function DeploysScreen({ me }: { me: Me }) {
  const [events, setEvents] = useState<DeployEvent[] | null>(null);
  // Whether the events on screen came from a filtered query; the empty state must match the shown rows,
  // not the filters already applied to the next request.
  const [shownFiltered, setShownFiltered] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [unavailable, setUnavailable] = useState<DeployUnavailableSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [brands, setBrands] = useState<LifecycleBrandSummary[]>([]);
  const [brandsFailed, setBrandsFailed] = useState(false);
  const [brand, setBrand] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, InstallWithReceipts>>({});
  const [detailError, setDetailError] = useState<Record<string, string>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  // The key ties the grown limit to the filters that grew it: a filter change reads as the start limit again.
  const filterKey = `${brand}\n${source}\n${status}`;
  const [more, setMore] = useState({ key: filterKey, limit: LIMIT_START });
  const limit = more.key === filterKey ? more.limit : LIMIT_START;
  // Guards a double click before the first receipts answer lands; the state cache covers every later expand.
  const loading = useRef(new Set<string>());
  const brandSelectRef = useRef<HTMLSelectElement>(null);
  const detailRegionRef = useRef<HTMLDivElement>(null);
  const labelOf = useBrandLabels();

  // The brand filter offers every brand the panel knows. An event for an unknown brand still renders its id.
  useEffect(() => {
    let active = true;
    api.lifecycleBrands().then(
      (r) => { if (active) setBrands(r.brands); },
      // The timeline still renders; only the filter loses its options, so say so next to the select.
      () => { if (active) setBrandsFailed(true); },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const query: DeployHistoryQuery = { limit };
    if (brand) query.brand = brand;
    if (source) query.source = source as DeploySource;
    if (status) query.status = status as DeployStatus;
    const fromFilters = brand !== "" || source !== "" || status !== "";
    api.deploys(query).then((r) => {
      if (!active) return;
      setEvents(r.events);
      setHasMore(r.has_more);
      setUnavailable(r.unavailable);
      setShownFiltered(fromFilters);
      setLoadingMore(false);
      setError(null);
    }, (e: unknown) => {
      // A failed feed is an error line, never a blank timeline that reads as "nothing happened".
      if (!active) return;
      setEvents([]);
      setHasMore(false);
      setUnavailable([]);
      setShownFiltered(fromFilters);
      setLoadingMore(false);
      setError(e instanceof ApiError ? e.thai : "โหลดประวัติการติดตั้งไม่สำเร็จ (Could not load the deploy history.)");
    });
    return () => { active = false; };
  }, [brand, source, status, limit]);

  // A filter change closes the open row: it may leave the feed, then come back by itself when filters clear.
  useEffect(() => { setOpenId(null); }, [brand, source, status]);

  // Keep the opened detail in view without stealing focus. jsdom has no scrollIntoView, so guard the call.
  useEffect(() => {
    if (openId) detailRegionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [openId]);

  const loadDetail = (event: DeployEvent) => {
    if (event.source !== "install" || details[event.event_id] || loading.current.has(event.event_id)) return;
    loading.current.add(event.event_id);
    api.installDetail(event.event_id).then(
      (detail) => setDetails((prev) => ({ ...prev, [event.event_id]: detail })),
      () => setDetailError((prev) => ({ ...prev, [event.event_id]: "โหลดรายละเอียดการติดตั้งไม่สำเร็จ (Could not load the install receipts.)" })),
    ).finally(() => loading.current.delete(event.event_id));
  };
  const toggle = (event: DeployEvent) => {
    const open = openId !== event.event_id;
    setOpenId(open ? event.event_id : null);
    if (open) loadDetail(event);
  };
  const loadMore = () => {
    if (loadingMore || !hasMore || limit >= LIMIT_MAX) return;
    setLoadingMore(true);
    setMore({ key: filterKey, limit: Math.min(LIMIT_MAX, limit + LIMIT_STEP) });
  };
  const clearFilters = () => {
    setBrand(""); setSource(""); setStatus("");
    // The Clear button is about to leave the screen; put focus back on the first filter.
    brandSelectRef.current?.focus();
  };
  const openEvent = events?.find((e) => e.event_id === openId) ?? null;

  const columns: Column<DeployEvent>[] = [
    {
      key: "at",
      header: "เวลา",
      cell: (e) => <div className="deploy-when">
        <time dateTime={e.started_at}>{fmtTime(e.started_at)}</time>
        <button type="button" className="btn" aria-expanded={openId === e.event_id} aria-controls={detailRegionId(e.event_id)} onClick={() => toggle(e)}>
          <span aria-hidden="true">{openId === e.event_id ? "▾" : "▸"}</span> รายละเอียด (Details)
        </button>
      </div>,
    },
    { key: "brand", header: "แบรนด์", cell: (e) => <BrandLabel brandId={e.brand_id} domain={labelOf(e.brand_id)} /> },
    { key: "operation", header: "การทำงาน", cell: (e) => (e.operation ? operationLabel[e.operation] : <code>{e.action ?? "—"}</code>) },
    { key: "status", header: "สถานะ", cell: (e) => <StatusBadge tone={statusBadgeTone[e.status] ?? "mute"} label={statusLabel[e.status] ?? e.status} /> },
    {
      key: "actor",
      header: "ผู้เริ่ม",
      cell: (e) => <><span className="mono">{e.started_by}</span> <span className={`pill ${e.started_role === "owner" ? "p-blue" : "p-mute"}`}>{actorRole(e.started_role)}</span></>,
    },
    { key: "duration", header: "ใช้เวลา", cell: (e) => fmtDuration(e.started_at, e.finished_at) },
    {
      key: "revision",
      header: "revision",
      mono: true,
      // The two ids are long; wrap them and keep each full id in a title.
      cell: (e) => <span className="deploy-revision">
        <span title={e.from_revision_id ?? undefined}>{e.from_revision_id ?? "—"}</span>{" → "}
        <span title={e.to_revision_id ?? undefined}>{e.to_revision_id ?? "—"}</span>
      </span>,
    },
  ];

  return <div className="stack deploys-page">
    <div className="head">
      <div>
        <h1 aria-label="ประวัติการติดตั้ง (Deploy history)">ประวัติการติดตั้ง</h1>
        <p className="sub">ไทม์ไลน์การติดตั้ง การย้อนกลับ และการแก้ไขค่าของทุกแบรนด์</p>
      </div>
    </div>
    <p className="hint">{me.role === "owner" ? "แสดงทุกเหตุการณ์ (All events)" : "แสดงงานติดตั้งทั้งหมด และเฉพาะประวัติการแก้ไขของคุณ (Every install, only your own audit rows)"}</p>
    <div className="deploys-filters">
      <div className="deploys-filter">
        <label>แบรนด์ (Brand)
          <select ref={brandSelectRef} value={brand} onChange={(e) => setBrand(e.target.value)} aria-describedby={brandsFailed ? "deploys-brand-hint" : undefined}>
            <option value="">ทั้งหมด (All)</option>
            {brands.map((b) => <option key={b.brand_id} value={b.brand_id}>{b.hostnames[0] ?? b.brand_id}</option>)}
          </select>
        </label>
        {/* Outside the label: a failure note must not join the select's accessible name. */}
        {brandsFailed && <span id="deploys-brand-hint" className="hint">โหลดรายการแบรนด์ไม่สำเร็จ (Could not load the brand list.)</span>}
      </div>
      <div className="deploys-filter">
        <label>แหล่งที่มา (Source)
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">ทั้งหมด (All)</option>
            {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <div className="deploys-filter">
        <label>สถานะ (Status)
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">ทั้งหมด (All)</option>
            {STATUSES.map((s) => <option key={s} value={s}>{statusLabel[s] ?? s}</option>)}
          </select>
        </label>
      </div>
    </div>
    {error
      ? <p className="error" role="alert">{error}</p>
      : !events ? <Spinner />
      : <>
        <section className="panel">
          <DataTable
            label="ประวัติการติดตั้ง"
            columns={columns}
            rows={events}
            rowKey={(e) => e.event_id}
            empty={shownFiltered
              ? <EmptyState
                title="ไม่พบรายการที่ตรงกับตัวกรอง (No deploys match the filters)"
                hint="ล้างตัวกรองเพื่อดูไทม์ไลน์ทั้งหมด (Clear the filters to see the whole timeline)"
                action={<button type="button" className="btn" onClick={clearFilters}>ล้างตัวกรอง (Clear filters)</button>}
              />
              : <EmptyState title="ยังไม่มีรายการติดตั้ง (No deploys yet)" hint="การติดตั้ง การย้อนกลับ และการแก้ไขค่าจะขึ้นที่นี่" />}
          />
          {/* One region, full width, directly below the table, named by its visible head so the time is in the name. */}
          {openEvent && <div
            ref={detailRegionRef}
            id={detailRegionId(openEvent.event_id)}
            className="deploy-detail-region"
            role="region"
            aria-labelledby={detailHeadId(openEvent.event_id)}
          >
            <p id={detailHeadId(openEvent.event_id)} className="deploy-detail-head">รายละเอียด (Details): {labelOf(openEvent.brand_id)} · {rowWhat(openEvent)} · {fmtTime(openEvent.started_at)}</p>
            <EventDetail event={openEvent} detail={details[openEvent.event_id]} error={detailError[openEvent.event_id]} />
          </div>}
        </section>
        <div className="deploys-foot">
          <LoadMore shown={events.length} hasMore={hasMore} atMax={limit >= LIMIT_MAX} loading={loadingMore} onMore={loadMore} narrowHint="กรุณากรองให้แคบลง (Narrow the filters)" />
          {unavailable.length > 0 && <p className="note">{unavailable.map((id) => UNAVAILABLE_NOTE[id]).join(" ")}</p>}
          <p className="hint"><a href="/audit" onClick={(e) => { if (!isPlainLeftClick(e)) return; e.preventDefault(); navigate("/audit"); }}>ดูประวัติการแก้ไขทั้งหมด (Full audit log)</a></p>
        </div>
      </>}
  </div>;
}
