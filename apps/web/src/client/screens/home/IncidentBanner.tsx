import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { inApp, num } from "./shared";
import { FIX_LABEL, type FixItem } from "./NeedsFixList";

/** Paid clicks against the visitors the brands recorded, when too few of them arrived. Owner only: an employee has no paid clicks. */
export interface ClickLoss { paid: number; reached: number }

/** Lines shown before the toggle, so a wide outage does not push the rest of Home below the fold. */
export const BANNER_LINES = 5;

/**
 * The top of Home: shown only while something is urgent, that is a failed conversion upload or alert that has reached the alert level,
 * or paid clicks that never reached the site. Each line says what and where. Nothing urgent renders nothing.
 * The banner holds every line its count names, each with its own button, so "มีเรื่องด่วน N เรื่อง" is the N lines under it.
 * Past BANNER_LINES lines it shows the first ones and a toggle that reveals the rest in place.
 * Each line names the brand by its domain (brand_id to domain from Home), like the fix list.
 * A line with a path links there, one with onAct runs it, any other opens the alerts screen.
 */
export function IncidentBanner({ urgent, clickLoss, onAlerts, domains }: { urgent: FixItem[]; clickLoss: ClickLoss | null; onAlerts?: () => void; domains?: ReadonlyMap<string, string> }) {
  const [expanded, setExpanded] = useState(false);
  const count = urgent.length + (clickLoss ? 1 : 0);
  if (count === 0) return null;
  const lines = urgent.map((item) => (
    <li key={item.id}>
      {`${domains?.get(item.brand) ?? item.brand}: ${item.message} `}
      {item.path
        ? <a className="btn" href={item.path} onClick={inApp(item.path)}>{FIX_LABEL[item.kind ?? "details"]}</a>
        : <button type="button" className="btn" onClick={item.onAct ?? onAlerts}>{FIX_LABEL[item.kind ?? "details"]}</button>}
    </li>
  ));
  if (clickLoss) {
    lines.push(
      <li key="click-loss">
        {`Google คิดเงิน ${num(clickLoss.paid)} คลิก แต่มาถึงเว็บเพียง ${num(clickLoss.reached)} คน `}
        <a className="btn" href="/traffic" onClick={inApp("/traffic")}>{FIX_LABEL.gclid}</a>
      </li>,
    );
  }
  const capped = count > BANNER_LINES;
  return (
    <section className="home-banner" role="alert" aria-label="เหตุด่วน">
      <AlertTriangle size={20} aria-hidden="true" />
      <div className="home-banner-body">
      <b>{`มีเรื่องด่วน ${count} เรื่อง`}</b>
      <ul id="home-banner-lines">
        {capped && !expanded ? lines.slice(0, BANNER_LINES) : lines}
      </ul>
      {capped && (
        <button type="button" className="btn" aria-expanded={expanded} aria-controls="home-banner-lines" onClick={() => setExpanded((open) => !open)}>
          {expanded ? "ย่อ" : `ดูทั้งหมด (${count})`}
        </button>
      )}
      </div>
    </section>
  );
}
