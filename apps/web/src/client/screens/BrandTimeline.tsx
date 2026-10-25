// spec timeline
import { roleAtLeast, type DeployUnavailableSource } from "@anjuna/contracts";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { BrandLabel, useBrandLabels } from "../brand-labels";
import { useConfirm } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { FilterBar } from "../components/FilterBar";
import { LoadMore } from "../components/LoadMore";
import { Spinner } from "../components/Spinner";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { operationLabel, statusBadgeTone, statusLabel } from "../labels";
import { isPlainLeftClick, navigate, routePath, useSearch } from "../router";
import { PANEL_ROLE_TABLE } from "../../server/panel-roles";
import {
  ADS_EVENT_LABEL,
  ADS_EVENT_TONE,
  CHANGE_CATEGORY_LABEL,
  filtersToQuery,
  fmtSince,
  groupByDay,
  isNearChange,
  localInputNow,
  localInputToIso,
  normalizeTypes,
  parseTimelineSearch,
  sinceLastChange,
  timelineSearch,
  type RangePreset,
  type TimelineFilters,
} from "../timeline";
import { ADS_EVENT_TYPES, CHANGE_CATEGORIES, type AdsEventType, type RevisionRef, type TimelineItem, type TimelineResponse, type TimelineType } from "../../shared/timeline";
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

// spec polish D3.1: Load more doubles the window up to the server's cap of 200.
const LIMIT_START = 100;
const LIMIT_MAX = 200;

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

function EventRow({ item, since, onDelete, deleting }: { item: EventItem; since: { change: ChangeItem; ms: number } | undefined; onDelete: (() => void) | undefined; deleting: boolean }) {
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
        <a href={`#tl-${since.change.item_id}`}>หลังการเปลี่ยนแปลงล่าสุด {fmtSince(since.ms)} (after the last change): {CHANGE_CATEGORY_LABEL[since.change.category]} · {changeWhat(since.change)}</a>
      </p>}
      {onDelete && <div className="tl-actions"><button type="button" className="btn danger" disabled={deleting} onClick={onDelete}>ลบ (Delete)</button></div>}
    </div>
  </li>;
}

const NOTE_MAX = 500;
const OTHER_NEEDS_NOTE = "ต้องใส่หมายเหตุสำหรับประเภทอื่น ๆ (A note is required for Other)";
const BAD_TIME = "เวลาไม่ถูกต้อง (Enter a valid date and time)";

type FormField = "type" | "occurred_at" | "note";
type FieldIssues = Partial<Record<FormField, string[]>>;
const isFormField = (path: string): path is FormField => path === "type" || path === "occurred_at" || path === "note";

function AddEventForm({ brandId, onSaved, onError }: { brandId: string; onSaved: () => void; onError: (text: string) => void }) {
  const ids = useId();
  const [type, setType] = useState<AdsEventType>(ADS_EVENT_TYPES[0]);
  const [when, setWhen] = useState(() => localInputNow(new Date()));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<FieldIssues>({});

  const needsNote = type === "other" && note.trim() === "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || needsNote) return;
    const occurredAt = localInputToIso(when);
    if (occurredAt === null) { setIssues({ occurred_at: [BAD_TIME] }); return; }
    setIssues({});
    setBusy(true);
    try {
      await api.createAdsEvent(brandId, { type, occurred_at: occurredAt, note: note.trim() });
      setType(ADS_EVENT_TYPES[0]);
      setWhen(localInputNow(new Date()));
      setNote("");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.body?.issues?.length) {
        const next: FieldIssues = {};
        const rest: string[] = [];
        for (const issue of err.body.issues) {
          if (isFormField(issue.path)) (next[issue.path] ??= []).push(issue.message);
          else rest.push(`${issue.path} ${issue.message}`.trim());
        }
        setIssues(next);
        if (rest.length) onError(`ข้อมูลไม่ถูกต้อง: ${rest.join("; ")}`);
      } else {
        onError(err instanceof ApiError ? err.thai : "บันทึกเหตุการณ์ไม่สำเร็จ (Could not save the event.)");
      }
    } finally {
      setBusy(false);
    }
  };

  const fieldIssues = (field: FormField) => issues[field] && <div id={`${ids}-${field}-err`}>
    {issues[field].map((message) => <p key={message} className="tl-field-error">{message}</p>)}
  </div>;
  const invalid = (field: FormField) => (issues[field] ? true : undefined);
  const noteDescribedBy = [needsNote && `${ids}-note-need`, issues.note && `${ids}-note-err`].filter(Boolean).join(" ") || undefined;

  return <section className="panel tl-form-panel" aria-label="บันทึกเหตุการณ์ (Add event)">
    <p className="tl-form-head">บันทึกเหตุการณ์ (Add event)</p>
    <form className="tl-form" onSubmit={submit}>
      <div className="tl-form-row">
        <label>
          <span id={`${ids}-type`}>ประเภท (Type)</span>
          <select value={type} aria-labelledby={`${ids}-type`} aria-invalid={invalid("type")} aria-describedby={issues.type ? `${ids}-type-err` : undefined} onChange={(e) => setType(e.target.value as AdsEventType)}>
            {ADS_EVENT_TYPES.map((id) => <option key={id} value={id}>{ADS_EVENT_LABEL[id]}</option>)}
          </select>
          {fieldIssues("type")}
        </label>
        <label>
          <span id={`${ids}-occurred_at`}>เวลาที่เกิดเหตุ (Time)</span>
          <input type="datetime-local" value={when} required aria-labelledby={`${ids}-occurred_at`} aria-invalid={invalid("occurred_at")} aria-describedby={issues.occurred_at ? `${ids}-occurred_at-err` : undefined} onChange={(e) => setWhen(e.target.value)} />
          {fieldIssues("occurred_at")}
        </label>
      </div>
      <label>
        <span id={`${ids}-note`}>หมายเหตุ (Note)</span>
        <textarea value={note} maxLength={NOTE_MAX} aria-labelledby={`${ids}-note`} aria-invalid={invalid("note") ?? (needsNote ? true : undefined)} aria-describedby={noteDescribedBy} onChange={(e) => setNote(e.target.value)} />
        {needsNote && <p id={`${ids}-note-need`} className="tl-field-error">{OTHER_NEEDS_NOTE}</p>}
        {fieldIssues("note")}
      </label>
      <p className="hint tl-counter">{note.length}/{NOTE_MAX}</p>
      <div className="tl-form-actions">
        <button type="submit" className="btn pri" disabled={busy || needsNote}>บันทึก (Save)</button>
      </div>
    </form>
  </section>;
}

export function BrandTimelineScreen({ me, brandId }: { me: Me; brandId: string }) {
  const canDelete = roleAtLeast(me.role, PANEL_ROLE_TABLE.deleteAdsEvent);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // The key ties the grown limit to the brand and filters that grew it: a brand or filter change reads as the start limit again.
  const filtersKey = timelineSearch(filters);
  const limitKey = `${brandId}\n${filtersKey}`;
  const [more, setMore] = useState({ key: limitKey, limit: LIMIT_START });
  const limit = more.key === limitKey ? more.limit : LIMIT_START;
  // Re-key during render on every brand or filter change, so returning to an earlier one never revives its grown limit.
  if (more.key !== limitKey) setMore({ key: limitKey, limit: LIMIT_START });
  // The limit of the rows on screen. atMax reads it, and a failed Load more falls back to it so a retry works.
  // loadedKey names the base key it was loaded for: only the pair together may skip a request, so the
  // StrictMode second run still fetches while the first answer is dropped by its cleanup.
  const loadedLimit = useRef(LIMIT_START);
  const loadedKey = useRef<string | null>(null);
  // A limit-only change keeps the rows on screen; anything else falls back to the spinner.
  const baseKey = `${brandId}\n${filtersKey}\n${noRequest}\n${reloadKey}`;
  const lastBaseKey = useRef<string | null>(null);

  useEffect(() => {
    if (noRequest) return;
    // A cleanup marks this request stale, so an answer for older filters never lands.
    let active = true;
    if (lastBaseKey.current !== baseKey) {
      lastBaseKey.current = baseKey;
      loadedLimit.current = LIMIT_START;
      loadedKey.current = null;
      setLoad({ state: "loading" });
      setLoadMoreError(null);
    } else if (loadedKey.current === baseKey && limit === loadedLimit.current) {
      // A failed Load more fell back to the loaded limit: the rows already shown are the answer.
      return () => { active = false; };
    }
    const growing = loadedKey.current === baseKey && limit !== loadedLimit.current;
    api.brandTimeline(brandId, { ...filtersToQuery(filters, new Date()), limit }).then(
      (data) => {
        if (!active) return;
        loadedKey.current = baseKey;
        loadedLimit.current = limit;
        setLoad({ state: "ready", data });
        setLoadingMore(false);
        setLoadMoreError(null);
      },
      (e: unknown) => {
        if (!active) return;
        setLoadingMore(false);
        const message = e instanceof ApiError ? e.thai : "โหลดไทม์ไลน์ไม่สำเร็จ (Could not load the timeline.)";
        if (growing) {
          // A failed Load more keeps the rows, shows the error by the button and falls back so a retry works.
          setLoadMoreError(message);
          setMore({ key: limitKey, limit: loadedLimit.current });
        // A malformed id never names a brand, so it reads like an unknown one.
        } else if (e instanceof ApiError && (e.status === 404 || (e.status === 400 && e.body?.error === "invalid_brand_id"))) setLoad({ state: "missing" });
        else setLoad({ state: "error", message });
      },
    );
    return () => { active = false; };
  }, [brandId, filters, noRequest, reloadKey, limit, filtersKey, baseKey]);

  const items = load.state === "ready" ? load.data.items : [];
  const groups = useMemo(() => groupByDay(items), [items]);
  const since = useMemo(() => sinceLastChange(items), [items]);

  const loadMore = () => {
    if (loadingMore || load.state !== "ready" || !load.data.has_more || limit >= LIMIT_MAX) return;
    setLoadingMore(true);
    setMore({ key: limitKey, limit: Math.min(LIMIT_MAX, limit + LIMIT_START) });
  };

  const removeEvent = async (item: EventItem) => {
    const label = ADS_EVENT_LABEL[item.event.type];
    const when = `${fmtDayHeading(item.at)} ${fmtClock(item.at)}`;
    const ok = await confirm({
      title: "ลบเหตุการณ์นี้? (Delete this event?)",
      body: `${label} เวลา ${when} (${label} at ${when})`,
      confirmLabel: "ลบ (Delete)",
      tone: "danger",
    });
    if (!ok) return;
    setDeletingIds((ids) => new Set(ids).add(item.item_id));
    try {
      await api.deleteAdsEvent(brandId, item.event.event_id);
      setToast({ kind: "ok", text: "ลบแล้ว (Deleted)" });
      reload();
    } catch (e) {
      setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "ลบไม่สำเร็จ (Could not delete the event.)" });
      // Someone else already removed it: the list is stale.
      if (e instanceof ApiError && e.status === 404) reload();
    } finally {
      setDeletingIds((ids) => {
        const next = new Set(ids);
        next.delete(item.item_id);
        return next;
      });
    }
  };

  if (load.state === "missing") return <NotFound title="ไม่พบแบรนด์ (Brand not found)" hint={brandId} />;

  const apply = (next: TimelineFilters) => navigate(window.location.pathname + timelineSearch(next), { replace: true });
  const toggleType = (id: TimelineType) =>
    apply({ ...filters, types: normalizeTypes(filters.types.includes(id) ? filters.types.filter((t) => t !== id) : [...filters.types, id]) });
  const setDay = (side: "from" | "to", value: string) =>
    apply({ ...filters, range: { from: customRange?.from ?? null, to: customRange?.to ?? null, [side]: value || null } });
  const brandHref = routePath({ view: "brands", brandId });
  const isDefault = timelineSearch(filters) === "";
  // Unchecked types plus a custom From/To range: the presets stay outside the modal, everything else counts.
  const uncheckedTypes = CHANGE_CATEGORIES.length + ADS_EVENT_TYPES.length - filters.types.length;
  const rangeActive = customRange !== null && (customRange.from || customRange.to) ? 1 : 0;

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
          : <EventRow key={item.item_id} item={item} since={since.get(item.item_id)} onDelete={canDelete ? () => void removeEvent(item) : undefined} deleting={deletingIds.has(item.item_id)} />)}
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
        <FilterBar label="ตัวกรองไทม์ไลน์ (Timeline filters)" activeCount={rangeActive + uncheckedTypes}>
        <label>ตั้งแต่ (From)
          <input type="date" value={customRange?.from ?? ""} onChange={(e) => setDay("from", e.target.value)} />
        </label>
        <label>ถึง (To)
          <input type="date" value={customRange?.to ?? ""} onChange={(e) => setDay("to", e.target.value)} />
        </label>
        <fieldset className="tl-types">
          <legend>การเปลี่ยนแปลง (Changes)</legend>
          {CHANGE_CATEGORIES.map((id) => typeBox(id, CHANGE_CATEGORY_LABEL[id]))}
        </fieldset>
        <fieldset className="tl-types">
          <legend>เหตุการณ์บัญชี Ads (Ads account events)</legend>
          {ADS_EVENT_TYPES.map((id) => typeBox(id, ADS_EVENT_LABEL[id]))}
        </fieldset>
        <button type="button" className="btn" disabled={isDefault} onClick={() => navigate(window.location.pathname, { replace: true })}>ล้างตัวกรอง (Reset filters)</button>
        </FilterBar>
      </div>
    </section>
    <AddEventForm
      brandId={brandId}
      onSaved={() => { setToast({ kind: "ok", text: "บันทึกเหตุการณ์แล้ว (Event saved)" }); reload(); }}
      onError={(text) => setToast({ kind: "err", text })}
    />
    <section className="panel tl-list" aria-label="รายการ (Timeline)">{body}</section>
    {load.state === "ready" && !noRequest && <div className="tl-notes">
      {load.data.unavailable.length > 0 && <p className="note">{load.data.unavailable.map((id) => UNAVAILABLE_NOTE[id]).join(" ")}</p>}
      {loadMoreError && <p className="note neg" role="alert">{loadMoreError}</p>}
      <LoadMore shown={items.length} hasMore={load.data.has_more} atMax={loadedLimit.current >= LIMIT_MAX} loading={loadingMore} onMore={loadMore} narrowHint="กรุณาเลือกช่วงวันที่ให้แคบลง (Narrow the date range)" />
      {load.data.actor_scope === "own" && <p className="hint">{OWN_SCOPE_HINT}</p>}
    </div>}
    {confirmDialog}
    {toast && <Toast kind={toast.kind} text={toast.text} onDismiss={() => setToast(null)} />}
  </div>;
}
