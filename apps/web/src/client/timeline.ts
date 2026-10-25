/**
 * Pure helpers of the brand timeline screen: labels, filter state in the URL, day grouping and the
 * "change, then event" marker. No React and no fetch, so the worker test project covers them.
 */
import type { Tone } from "./components/StatusBadge";
import { ADS_EVENT_TYPES, CHANGE_CATEGORIES, type AdsEventType, type ChangeCategory, type TimelineItem, type TimelineType } from "../shared/timeline";

export const ADS_EVENT_LABEL: Record<AdsEventType, string> = {
  ad_disapproved: "โฆษณาถูกปฏิเสธ (Ad disapproved)",
  account_suspended: "บัญชีถูกระงับ (Account suspended)",
  account_reinstated: "บัญชีกลับมาใช้ได้ (Account reinstated)",
  policy_warning: "คำเตือนนโยบาย (Policy warning)",
  bot_visit_observed: "พบการเข้าชมของบอท (Bot visit observed)",
  other: "อื่น ๆ (Other)",
};

export const ADS_EVENT_TONE: Record<AdsEventType, Tone> = {
  ad_disapproved: "bad",
  account_suspended: "bad",
  account_reinstated: "live",
  policy_warning: "warn",
  bot_visit_observed: "warn",
  other: "mute",
};

export const CHANGE_CATEGORY_LABEL: Record<ChangeCategory, string> = {
  config: "แก้ค่าแบรนด์ (Config change)",
  pause_resume: "หยุด/เปิดแบรนด์ (Pause/Resume)",
  deploy: "ติดตั้ง/ย้อนกลับ (Deploy/Rollback)",
  factory_edit: "แก้ไขใน factory (Factory edit)",
};

export type RangePreset = "7d" | "30d" | "90d" | "all";

export interface TimelineFilters {
  /** A preset, or local calendar days `YYYY-MM-DD` (null = open end). */
  range: RangePreset | { from: string | null; to: string | null };
  /** Every type id means no type filter. */
  types: TimelineType[];
}

/** Query of `api.brandTimeline`; `types` is a comma list. */
export interface TimelineRequestQuery {
  from?: string;
  to?: string;
  types?: string;
  limit?: number;
}

const ALL_TYPES: readonly TimelineType[] = [...CHANGE_CATEGORIES, ...ADS_EVENT_TYPES];
const PRESETS: readonly RangePreset[] = ["7d", "30d", "90d", "all"];
const PRESET_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
const DAY_MS = 24 * 3600_000;
const DEFAULT_PRESET: RangePreset = "30d";

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** A real calendar day typed as `YYYY-MM-DD`, else null. */
function parseDay(value: string | null): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(0);
  probe.setFullYear(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d ? { y, m, d } : null;
}

/** Local-time Date from calendar and clock parts. `setFullYear` avoids `new Date(y, ...)` mapping years 0 to 99 to 19xx. */
function localDate(y: number, m: number, d: number, h: number, min: number, s: number, ms: number): Date {
  const date = new Date(0);
  date.setFullYear(y, m - 1, d);
  date.setHours(h, min, s, ms);
  return date;
}

export function parseTimelineSearch(search: string): TimelineFilters {
  const params = new URLSearchParams(search);
  const rawRange = params.get("range");
  let range: TimelineFilters["range"] = DEFAULT_PRESET;
  const preset = PRESETS.find((p) => p === rawRange);
  if (preset) range = preset;
  else if (params.has("from") || params.has("to")) {
    const from = params.get("from");
    const to = params.get("to");
    range = { from: parseDay(from) ? from : null, to: parseDay(to) ? to : null };
  }
  const rawTypes = params.get("types");
  const types = rawTypes === null ? [...ALL_TYPES] : ALL_TYPES.filter((id) => rawTypes.split(",").includes(id));
  return { range, types };
}

/** `""` for the defaults (30 days, every type). */
export function timelineSearch(filters: TimelineFilters): string {
  const parts: string[] = [];
  if (typeof filters.range === "string") {
    if (filters.range !== DEFAULT_PRESET) parts.push(`range=${filters.range}`);
  } else {
    parts.push(`from=${filters.range.from ?? ""}`, `to=${filters.range.to ?? ""}`);
  }
  const chosen = ALL_TYPES.filter((id) => filters.types.includes(id));
  if (chosen.length !== ALL_TYPES.length) parts.push(`types=${chosen.join(",")}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Request query for the filters. Presets count back from `now`; custom days are local-day bounds.
 * `types` is left out for all types and for none (the screen makes no request when none is checked).
 */
export function filtersToQuery(filters: TimelineFilters, now: Date): TimelineRequestQuery {
  const query: TimelineRequestQuery = {};
  if (typeof filters.range === "string") {
    if (filters.range !== "all") query.from = new Date(now.getTime() - PRESET_DAYS[filters.range] * DAY_MS).toISOString();
  } else {
    const from = parseDay(filters.range.from);
    const to = parseDay(filters.range.to);
    if (from) query.from = localDate(from.y, from.m, from.d, 0, 0, 0, 0).toISOString();
    if (to) query.to = localDate(to.y, to.m, to.d, 23, 59, 59, 999).toISOString();
  }
  const chosen = ALL_TYPES.filter((id) => filters.types.includes(id));
  if (chosen.length > 0 && chosen.length < ALL_TYPES.length) query.types = chosen.join(",");
  return query;
}

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Consecutive items on the same local calendar day share a group; the order of `items` is kept. */
export function groupByDay(items: TimelineItem[]): { day: string; items: TimelineItem[] }[] {
  const groups: { day: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const day = localDay(Date.parse(item.at));
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

type ChangeItem = Extract<TimelineItem, { kind: "change" }>;

/** For each Ads event, the newest change at or before it. An event with no earlier change has no entry. */
export function sinceLastChange(items: TimelineItem[]): Map<string, { change: ChangeItem; ms: number }> {
  const changes: { item: ChangeItem; at: number }[] = [];
  for (const item of items) {
    if (item.kind !== "change") continue;
    const at = Date.parse(item.at);
    if (Number.isFinite(at)) changes.push({ item, at });
  }
  const out = new Map<string, { change: ChangeItem; ms: number }>();
  for (const item of items) {
    if (item.kind !== "ads_event") continue;
    const at = Date.parse(item.at);
    if (!Number.isFinite(at)) continue;
    let best: { item: ChangeItem; at: number } | null = null;
    for (const c of changes) if (c.at <= at && (best === null || c.at > best.at)) best = c;
    if (best) out.set(item.item_id, { change: best.item, ms: at - best.at });
  }
  return out;
}

/** The `fmtDuration` format of the Deploys screen, plus days from 48 hours on. */
export function fmtSince(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${seconds} วิ (${seconds}s)`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes} นาที (${minutes}m)` : `${minutes} นาที ${seconds % 60} วิ (${minutes}m ${seconds % 60}s)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} ชม. (${hours}h)` : `${hours} ชม. ${minutes % 60} นาที (${hours}h ${minutes % 60}m)`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} วัน (${days}d)` : `${days} วัน ${restHours} ชม. (${days}d ${restHours}h)`;
}

/** An event within 24 hours after a change. */
export const isNearChange = (ms: number): boolean => ms <= 24 * 3600_000;

/** Value for `<input type="datetime-local">`: local `YYYY-MM-DDTHH:mm`. */
export const localInputNow = (now: Date): string =>
  `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

/** A `datetime-local` value read as local time and sent as UTC ISO; null for a value that is not a real local time. */
export function localInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [y, m, d, h, min, s] = [match[1], match[2], match[3], match[4], match[5], match[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  const date = localDate(y, m, d, h, min, s, 0);
  // A nonexistent local time (a day that does not have it, or a DST gap) makes the fields shift.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== min || date.getSeconds() !== s) return null;
  return date.toISOString();
}
