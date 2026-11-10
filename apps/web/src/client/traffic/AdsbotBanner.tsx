import { AlertTriangle, ExternalLink } from "lucide-react";
import { clock } from "./live";

/** What the banner shows of one AdsBot visit. A live event carries a session ref; a visit from the report does not. */
export interface AdsbotVisit {
  /** The brand id, so the page can drop a visit that the brand scope hides. */
  brand: string;
  brandLabel: string;
  url: string;
  httpStatus: number | null;
  responseMs: number | null;
  gatePassed: boolean | null;
  at: number;
  sessionRef: string | null;
}

/**
 * Google's ad checker visited a landing page. It is a warning when the page answered 200, and an alert when it did not,
 * because a failing page gets the ad disapproved. The buttons scroll to the session in the feed and open the page for the Google Ads review.
 */
export function AdsbotBanner({ visit, onShowSession }: { visit: AdsbotVisit; onShowSession: (ref: string) => void }) {
  const ok = visit.httpStatus === 200;
  return (
    <div role="alert" className={`rt-adsbot ${ok ? "rt-adsbot-warn" : "rt-adsbot-bad"}`} data-tone={ok ? "warning" : "danger"}>
      <AlertTriangle aria-hidden="true" size={20} />
      <div className="rt-adsbot-text">
        <b>AdsBot เข้าตรวจหน้า {visit.brandLabel}</b>
        <span>
          {ok ? "หน้าตอบกลับปกติ" : `หน้าตอบกลับ HTTP ${visit.httpStatus ?? "ไม่มีสถานะ"} ตรวจก่อนโฆษณาถูกปฏิเสธ`}
          {" · "}
          <span className="num">{visit.httpStatus ?? "—"}</span>
          {visit.responseMs !== null && <> · <span className="num">{Math.round(visit.responseMs)} ms</span></>}
          {visit.gatePassed !== null && <> · {visit.gatePassed ? "ผ่านด่านตรวจ" : "ไม่ผ่านด่านตรวจ"}</>}
          {" · "}<span className="num">{clock(visit.at)} UTC</span>
        </span>
      </div>
      <div className="rt-adsbot-actions">
        {visit.sessionRef && <button type="button" className="btn" onClick={() => onShowSession(visit.sessionRef!)}>ดูเซสชัน</button>}
        <a className="btn" href={visit.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={16} />ดูหน้าใน Google Ads</a>
      </div>
    </div>
  );
}
