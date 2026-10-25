// spec timeline
import type { DeployUnavailableSource } from "@anjuna/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { BrandLabel, useBrandLabels } from "../brand-labels";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { StatusBadge } from "../components/StatusBadge";
import { operationLabel, statusBadgeTone, statusLabel } from "../labels";
import { isPlainLeftClick, navigate, routePath, useSearch } from "../router";
import {
  ADS_EVENT_LABEL,
  ADS_EVENT_TONE,
  CHANGE_CATEGORY_LABEL,
  filtersToQuery,
  fmtSince,
  groupByDay,
  isNearChange,
  parseTimelineSearch,
  sinceLastChange,
  timelineSearch,
  type RangePreset,
  type TimelineFilters,
} from "../timeline";
import { ADS_EVENT_TYPES, CHANGE_CATEGORIES, type RevisionRef, type TimelineItem, type TimelineResponse, type TimelineType } from "../../shared/timeline";
import { NotFound } from "./NotFound";
import "./BrandTimeline.css";

type ChangeItem = Extract<TimelineItem, { kind: "change" }>;
type EventItem = Extract<TimelineItem, { kind: "ads_event" }>;

type Load =
  | { state: "loading" }
  | { state: "ready"; data: TimelineResponse }
  | { state: "error"; message: string }
  | { state: "missing" };

const PRESET_LABEL: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: "7d", label: "7 วัน" },
  { value: "30d", label: "30 วัน" },
  { value: "90d", label: "90 วัน" },
  { value: "all", label: "ทั้งหมด (All)" },
];

const UNAVAILABLE_NOTE: Record<DeployUnavailableSource, string> = {
  core_audit: "ไทม์ไลน์ไม่ครบ: อ่านประวัติจาก Core ไม่ได้ (core_audit) การแก้ไขค่าของแบรนด์ที่ Core บันทึกอยู่อาจหายไป (Part of the timeline is missing: the core audit source is unavailable.)",
};

const OWN_SCOPE_HINT = "คุณเห็นเฉพาะการแก้ไขที่คุณทำเอง การติดตั้งและเหตุการณ์ Ads แสดงครบ (You see only your own edits; deploys and Ads events are complete)";

const pad = (n: number) => String(n).padStart(2, "0");
const fmtClock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtDayHeading = (iso: string) => new Date(iso).toLocaleDateString("th-TH", { dateStyle: "long" });

const roleLabel = (role: string): string => (role === "owner" ? "Owner" : role === "employee" ? "พนักงาน" : role);

function Actor({ id, role }: { id: string; role: string }) {
  return <span className="tl-actor"><span className="mono">{id}</span> <span className={`pill ${role === "owner" ? "p-blue" : "p-mute"}`}>{roleLabel(role)}</span></span>;
}

/** The operation label of an install row, or the action code of an audit row. */
const changeWhat = (item: ChangeItem): string => (item.change.operation ? operationLabel[item.change.operation] : item.change.action ?? "—");

/** "template a → b · form c → d", only the parts that differ; null when neither revision is known or nothing differs. */
function versionChange(from: RevisionRef | null, to: RevisionRef | null): string | null {
  if (!from && !to) return null;
  const parts: string[] = [];
  const [templateFrom, templateTo] = [from?.template_version_id ?? "—", to?.template_version_id ?? "—"];
  if (templateFrom !== templateTo) parts.push(`template ${templateFrom} → ${templateTo}`);
  const [formFrom, formTo] = [from?.bundle_form_version ?? "—", to?.bundle_form_version ?? "—"];
  if (formFrom !== formTo) parts.push(`form ${formFrom} → ${formTo}`);
  return parts.length ? parts.join(" · ") : null;
}

function ChangeRow({ item }: { item: ChangeItem }) {
  const { change } = item;
  const versions = versionChange(item.from_revision, item.to_revision);
  return <li id={`tl-${item.item_id}`} className="tl-row tl-row-change">
    <span className="tl-marker tl-marker-change" aria-hidden="true" />
    <div className="tl-body">
      <div className="tl-line">
        <time dateTime={item.at} title={item.at}>{fmtClock(item.at)}</time>
        <span className="tl-category">{CHANGE_CATEGORY_LABEL[item.category]}</span>
        <span className="tl-what">{change.operation ? operationLabel[change.operation] : <code>{change.action ?? "—"}</code>}</span>
        {change.source === "install" && <StatusBadge tone={statusBadgeTone[change.status] ?? "mute"} label={statusLabel[change.status] ?? change.status} />}
      </div>
      {versions && <p className="tl-versions mono">{versions}</p>}
      <p className="tl-meta"><Actor id={change.started_by} role={change.started_role} /></p>
    </div>
  </li>;
}

function EventRow({ item, since }: { item: EventItem; since: { change: ChangeItem; ms: number } | undefined }) {
  const { event } = item;
  const tone = ADS_EVENT_TONE[event.type];
  const near = since !== undefined && isNearChange(since.ms);
  return <li id={`tl-${item.item_id}`} className={`tl-row tl-row-event${near ? " tl-near-change" : ""}`}>
    <span className={`tl-marker tl-marker-event tl-tone-${tone}`} aria-hidden="true" />
    <div className="tl-body">
      <div className="tl-line">
        <time dateTime={item.at} title={item.at}>{fmtClock(item.at)}</time>
        <StatusBadge tone={tone} label={ADS_EVENT_LABEL[event.type]} />
      </div>
      {event.note && <p className="tl-note">{event.note}</p>}
      <p className="tl-meta"><Actor id={event.created_by} role={event.created_role} /></p>
      {since && <p className="tl-since">
        <a href={`#tl-${since.change.item_id}`}>หลังการเปลี่ยนแปลง {fmtSince(since.ms)} ({fmtSince(since.ms)} after: {CHANGE_CATEGORY_LABEL[since.change.category]} · {changeWhat(since.change)})</a>
      </p>}
      {/* spec D6 item 4: the Owner-only Delete button goes in this row. */}
    </div>
  </li>;
}

export function BrandTimelineScreen({ brandId }: { me: Me; brandId: string }) {
  const search = useSearch();
  const filters = useMemo(() => parseTimelineSearch(search), [search]);
  const labelOf = useBrandLabels();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const { range } = filters;
  const customRange = typeof range === "object" ? range : null;
  const rangeInverted = customRange !== null && customRange.from !== null && customRange.to !== null && customRange.from > customRange.to;
  // Nothing to ask for: no type is checked, or the range can match nothing.
  const noRequest = filters.types.length === 0 || rangeInverted;

  useEffect(() => {
    if (noRequest) return;
    // A cleanup marks this request stale, so an answer for older filters never lands.
    let active = true;
    setLoad({ state: "loading" });
    api.brandTimeline(brandId, filtersToQuery(filters, new Date())).then(
      (data) => { if (active) setLoad({ state: "ready", data }); },
      (e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 404) setLoad({ state: "missing" });
        else setLoad({ state: "error", message: e instanceof ApiError ? e.thai : "โหลดไทม์ไลน์ไม่สำเร็จ (Could not load the timeline.)" });
      },
    );
    return () => { active = false; };
  }, [brandId, filters, noRequest, reloadKey]);

  const items = load.state === "ready" ? load.data.items : [];
  const groups = useMemo(() => groupByDay(items), [items]);
  const since = useMemo(() => sinceLastChange(items), [items]);

  if (load.state === "missing") return <NotFound title="ไม่พบแบรนด์ (Brand not found)" hint={brandId} />;

  const apply = (next: TimelineFilters) => navigate(window.location.pathname + timelineSearch(next), { replace: true });
  const toggleType = (id: TimelineType) =>
    apply({ ...filters, types: filters.types.includes(id) ? filters.types.filter((t) => t !== id) : [...filters.types, id] });
  const setDay = (side: "from" | "to", value: string) =>
    apply({ ...filters, range: { from: customRange?.from ?? null, to: customRange?.to ?? null, [side]: value || null } });
  const brandHref = routePath({ view: "brands", brandId });
  const isDefault = timelineSearch(filters) === "";

  const typeBox = (id: TimelineType, label: string) => <label key={id} className="tl-check">
    <input type="checkbox" checked={filters.types.includes(id)} onChange={() => toggleType(id)} />
    <span>{label}</span>
  </label>;

  let body;
  if (noRequest) {
    body = <EmptyState
      title="ไม่มีรายการในช่วงนี้ (Nothing in this range)"
      hint={rangeInverted ? "วันที่เริ่มต้องไม่หลังวันที่สิ้นสุด (From must not be after To)" : "เลือกประเภทอย่างน้อยหนึ่งอย่าง (Check at least one type)"}
    />;
  } else if (load.state === "error") {
    body = <div className="tl-error" role="alert">
      <p>{load.message}</p>
      <button type="button" className="btn" onClick={reload}>ลองใหม่ (Retry)</button>
    </div>;
  } else if (load.state === "loading") {
    body = <Spinner />;
  } else if (items.length === 0) {
    body = <EmptyState title="ไม่มีรายการในช่วงนี้ (Nothing in this range)" />;
  } else {
    body = groups.map((group) => <section key={group.day} className="tl-day" aria-labelledby={`tl-day-${group.day}`}>
      <h2 id={`tl-day-${group.day}`} className="tl-day-head">{fmtDayHeading(group.items[0]!.at)}</h2>
      <ol className="tl-rows">
        {group.items.map((item) => item.kind === "change"
          ? <ChangeRow key={item.item_id} item={item} />
          : <EventRow key={item.item_id} item={item} since={since.get(item.item_id)} />)}
      </ol>
    </section>);
  }

  return <div className="stack timeline-page">
    <div className="head">
      <div>
        <h1>ไทม์ไลน์แบรนด์ (Brand timeline)</h1>
        <p className="sub"><BrandLabel brandId={brandId} domain={labelOf(brandId)} /></p>
      </div>
      <a href={brandHref} onClick={(e) => { if (!isPlainLeftClick(e)) return; e.preventDefault(); navigate(brandHref); }}>กลับไปที่แบรนด์ (Back to brand)</a>
    </div>
    <section className="panel tl-filters" aria-label="ตัวกรอง (Filters)">
      <div className="tl-filter-row">
        <div className="tl-presets" role="group" aria-label="ช่วงเวลา (Range)">
          {PRESET_LABEL.map((p) => <button key={p.value} type="button" className="btn" aria-pressed={range === p.value} onClick={() => apply({ ...filters, range: p.value })}>{p.label}</button>)}
        </div>
        <label>ตั้งแต่ (From)
          <input type="date" value={customRange?.from ?? ""} onChange={(e) => setDay("from", e.target.value)} />
        </label>
        <label>ถึง (To)
          <input type="date" value={customRange?.to ?? ""} onChange={(e) => setDay("to", e.target.value)} />
        </label>
        <button type="button" className="btn" disabled={isDefault} onClick={() => navigate(window.location.pathname, { replace: true })}>ล้างตัวกรอง (Reset filters)</button>
      </div>
      <fieldset className="tl-types">
        <legend>การเปลี่ยนแปลง (Changes)</legend>
        {CHANGE_CATEGORIES.map((id) => typeBox(id, CHANGE_CATEGORY_LABEL[id]))}
      </fieldset>
      <fieldset className="tl-types">
        <legend>เหตุการณ์บัญชี Ads (Ads account events)</legend>
        {ADS_EVENT_TYPES.map((id) => typeBox(id, ADS_EVENT_LABEL[id]))}
      </fieldset>
    </section>
    {/* spec D6 item 3: the add-event form renders here, above the list. */}
    <section className="panel tl-list" aria-label="รายการ (Timeline)">{body}</section>
    {load.state === "ready" && !noRequest && <div className="tl-notes">
      {load.data.unavailable.length > 0 && <p className="note">{load.data.unavailable.map((id) => UNAVAILABLE_NOTE[id]).join(" ")}</p>}
      {load.data.has_more && <p className="hint">แสดง {items.length} รายการล่าสุด ให้แคบช่วงวันที่เพื่อดูรายการเก่ากว่า (Showing the newest {items.length}; narrow the date range to see older items)</p>}
      {load.data.actor_scope === "own" && <p className="hint">{OWN_SCOPE_HINT}</p>}
    </div>}
  </div>;
}
