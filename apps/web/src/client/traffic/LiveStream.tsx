import type { TrafficTailEvent } from "@anjuna/contracts";
import { Pause, Play, Radio } from "lucide-react";
import { useMemo, useState } from "react";
import { Chip } from "../components/Chip";
import { BOT_LABEL, EVENT_FILTERS, type EventFilter, STAGE, clock, groupSessions, isBot, isErrorEvent, matchesFilter } from "./live";

const DEVICE: Record<string, string> = { mobile: "มือถือ", tablet: "แท็บเล็ต", desktop: "คอมพิวเตอร์", unknown: "ไม่ทราบ" };

/**
 * ทราฟฟิกสด: events grouped by session, newest session first, at most 40.
 * Each session shows its stage chain from the first event to the last, with error chips for a failed step or a page that answered 400 or more.
 * Filters: brand, event group, errors only. Pause freezes what is on screen; the stream keeps filling behind it.
 */
export function LiveStream({ events, labelOf }: { events: readonly TrafficTailEvent[]; labelOf: (brandId: string) => string }) {
  const [brand, setBrand] = useState("all");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [frozen, setFrozen] = useState<readonly TrafficTailEvent[] | null>(null);
  const paused = frozen !== null;

  const brands = useMemo(() => [...new Set(events.map((event) => event.brand))], [events]);
  const matching = useMemo(
    () => events.filter((event) => (brand === "all" || event.brand === brand) && (!onlyErrors || isErrorEvent(event)) && matchesFilter(event, filter)),
    [events, brand, filter, onlyErrors],
  );
  const shown = paused ? frozen : matching;
  const sessions = useMemo(() => groupSessions(shown), [shown]);
  const waiting = paused ? events.filter((event) => !frozen.includes(event)).length : 0;

  return (
    <section className="panel rt-stream" aria-label="ทราฟฟิกสด">
      <div className="rt-stream-head">
        <h2>ทราฟฟิกสด</h2>
        <Chip tone="info">รุ่นถัดไป: บันทึกและส่งออก</Chip>
      </div>
      <div className="rt-filters">
        <label>แบรนด์
          <select value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="กรองตามแบรนด์">
            <option value="all">ทุกแบรนด์</option>
            {brands.map((id) => <option key={id} value={id}>{labelOf(id)}</option>)}
          </select>
        </label>
        <label>เหตุการณ์
          <select value={filter} onChange={(e) => setFilter(e.target.value as EventFilter)} aria-label="กรองตามเหตุการณ์">
            {EVENT_FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="rt-check"><input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />เฉพาะที่ผิดพลาด</label>
        <button type="button" className="btn" aria-pressed={paused} onClick={() => setFrozen(paused ? null : matching)}>
          {paused ? <Play aria-hidden="true" size={16} /> : <Pause aria-hidden="true" size={16} />}
          {paused ? "เล่นต่อ" : "หยุดชั่วคราว"}
        </button>
      </div>
      {paused && <p className="hint" role="status">หยุดไว้ มีเหตุการณ์ใหม่ <b className="num">{waiting}</b> รายการรออยู่</p>}
      {sessions.length === 0 ? (
        <p className="rt-empty"><Radio aria-hidden="true" size={18} /> ยังไม่มีเหตุการณ์ที่ตรงกับตัวกรอง หน้าจะแสดงทันทีเมื่อมีผู้เข้าเว็บ</p>
      ) : (
        <ol className="rt-sessions" aria-label="เซสชันล่าสุด">
          {sessions.map((session) => (
            <li key={session.id} id={session.sessionRef ? `session-${session.sessionRef}` : undefined} className="rt-session" tabIndex={-1} data-session={session.sessionRef ?? undefined}>
              <div className="rt-session-head">
                <b>{session.domain}</b>
                <span className="hint">{labelOf(session.brand)}</span>
                {session.family !== "browser" && session.family !== "unknown" && <Chip tone={session.family === "adsbot" ? "warning" : "neutral"}>{BOT_LABEL[session.family]}</Chip>}
                <span className="hint">{DEVICE[session.device ?? "unknown"]}{session.browser && session.browser !== "unknown" ? ` · ${session.browser}` : ""}</span>
                {session.sessionRef && <code className="rt-ref">{session.sessionRef}</code>}
                <span className="num rt-time">{clock(session.lastTs)}</span>
              </div>
              <ul className="rt-chain" aria-label="ขั้นตอนของเซสชัน">
                {session.events.map((event) => {
                  const stage = STAGE[event.event_type];
                  const failing = event.http_status !== null && event.http_status >= 400;
                  return (
                    <li key={event.event_id} data-event={event.event_type}>
                      <Chip tone={stage.error ? "danger" : stage.kind === "lead" || stage.kind === "postback" ? "success" : "neutral"}>{stage.label}</Chip>
                      {failing && <Chip tone="danger">HTTP {event.http_status}</Chip>}
                      {isBot(event) && event.http_status !== null && !failing && <Chip tone="neutral">HTTP {event.http_status}</Chip>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
