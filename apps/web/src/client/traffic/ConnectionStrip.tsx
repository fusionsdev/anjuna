import { Volume2, VolumeX, Wifi, WifiOff } from "lucide-react";
import type { TailStatus } from "./useTrafficTail";
import { clock } from "./live";

const STATUS_TEXT: Record<TailStatus, string> = { connecting: "กำลังเชื่อมต่อ", live: "เชื่อมต่อแล้ว", reconnecting: "หลุดการเชื่อมต่อ กำลังต่อใหม่" };

/**
 * The strip above the live feed: the state of the stream, the time of the last event (UTC), events in the last minute,
 * and the switch for the AdsBot beep. The switch is a plain toggle button; the page keeps its value.
 */
export function ConnectionStrip({ status, lastEventAt, perMinute, sound, onSound }: { status: TailStatus; lastEventAt: number | null; perMinute: number; sound: boolean; onSound: (on: boolean) => void }) {
  const Status = status === "live" ? Wifi : WifiOff;
  return (
    <div className="rt-strip" role="group" aria-label="สถานะการเชื่อมต่อ">
      <span className={`rt-status rt-${status}`} role="status">
        <span className="rt-dot" aria-hidden="true" />
        <Status aria-hidden="true" size={18} />
        {STATUS_TEXT[status]}
      </span>
      <span className="rt-fact">เหตุการณ์ล่าสุด <b className="num">{lastEventAt === null ? "—" : `${clock(lastEventAt)} UTC`}</b></span>
      <span className="rt-fact"><b className="num">{perMinute}</b> เหตุการณ์ต่อนาที</span>
      <button type="button" className="btn rt-sound" aria-pressed={sound} onClick={() => onSound(!sound)}>
        {sound ? <Volume2 aria-hidden="true" size={18} /> : <VolumeX aria-hidden="true" size={18} />}
        เสียงเตือน AdsBot {sound ? "เปิด" : "ปิด"}
      </button>
    </div>
  );
}
