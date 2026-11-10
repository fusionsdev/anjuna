import type { TrafficTailEvent } from "@anjuna/contracts";

/** How a stream event reads in the stage chain of a session. `tone` marks errors; `kind` is the filter group. */
export type StageKind = "gate" | "landing" | "form" | "lead" | "redirect";
export const STAGE: Record<TrafficTailEvent["event_type"], { label: string; kind: StageKind; error?: true }> = {
  gate_viewed: { label: "ด่านตรวจ", kind: "gate" },
  landing_viewed: { label: "หน้าแรก", kind: "landing" },
  form_started: { label: "เริ่มกรอก", kind: "form" },
  form_step_viewed: { label: "เปิดขั้นตอน", kind: "form" },
  form_step_completed: { label: "ผ่านขั้นตอน", kind: "form" },
  form_validation_failed: { label: "กรอกผิด", kind: "form", error: true },
  lead_submission_started: { label: "กำลังส่งลีด", kind: "lead" },
  lead_submitted: { label: "ส่งลีดแล้ว", kind: "lead" },
  redirect_started: { label: "ส่งต่อผู้ซื้อ", kind: "redirect" },
  redirect_failed: { label: "ส่งต่อไม่สำเร็จ", kind: "redirect", error: true },
};

export type EventFilter = "all" | "landing" | "form" | "lead" | "redirect" | "bot";
export const EVENT_FILTERS: ReadonlyArray<{ id: EventFilter; label: string }> = [
  { id: "all", label: "ทุกเหตุการณ์" }, { id: "landing", label: "หน้าแรก" }, { id: "form", label: "ฟอร์ม" },
  { id: "lead", label: "ส่งลีด" }, { id: "redirect", label: "ส่งต่อ" }, { id: "bot", label: "บอท" },
];

export const BOT_LABEL = { googlebot: "Googlebot", adsbot: "AdsBot", "other-bot": "บอทอื่น" } as const;
export const isBot = (event: Pick<TrafficTailEvent, "user_agent_family">) => event.user_agent_family === "googlebot" || event.user_agent_family === "adsbot" || event.user_agent_family === "other-bot";

/** An event is an error when its stage is one, or when the page answered with a status of 400 or more. */
export const isErrorEvent = (event: TrafficTailEvent) => STAGE[event.event_type].error === true || (event.http_status !== null && event.http_status >= 400);

export function matchesFilter(event: TrafficTailEvent, filter: EventFilter): boolean {
  if (filter === "all") return true;
  if (filter === "bot") return isBot(event);
  const kind = STAGE[event.event_type].kind;
  return filter === "landing" ? kind === "gate" || kind === "landing" : kind === filter;
}

export interface LiveSession {
  /** The key of the row: the session ref, or the event id for an event that has none. */
  id: string;
  sessionRef: string | null;
  domain: string;
  brand: string;
  device: TrafficTailEvent["device_type"];
  browser: TrafficTailEvent["browser"];
  family: TrafficTailEvent["user_agent_family"];
  /** Oldest first, the order of the stage chain. */
  events: TrafficTailEvent[];
  lastTs: number;
}

export const MAX_SESSIONS = 40;

/** Groups events by session ref, newest session first, at most MAX_SESSIONS. `events` is newest first, as the stream keeps it. */
export function groupSessions(events: readonly TrafficTailEvent[]): LiveSession[] {
  const byId = new Map<string, LiveSession>();
  for (const event of events) {
    const id = event.session_ref ?? `event-${event.event_id}`;
    const found = byId.get(id);
    if (found) {
      found.events.unshift(event);
      continue;
    }
    byId.set(id, { id, sessionRef: event.session_ref, domain: event.domain, brand: event.brand, device: event.device_type, browser: event.browser, family: event.user_agent_family, events: [event], lastTs: event.ts });
  }
  return [...byId.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, MAX_SESSIONS);
}

/** UTC clock time read from the timestamp, never from the viewer's time zone. */
export const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);
export const clockIso = (iso: string) => iso.slice(11, 19);

/** Percentage change as "+12%", "-3%" or "0%". Null (no earlier value) reads as a dash. */
export function deltaText(delta: number | null): string {
  if (delta === null) return "—";
  const rounded = Math.round(delta);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

const csvCell = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
/** CSV text with a UTF-8 byte order mark, so Excel opens Thai text correctly. */
export function csvText(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  return `﻿${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
