import { num } from "./shared";
import type { FixItem } from "./NeedsFixList";

/** Paid clicks against the visitors the brands recorded, when too few of them arrived. Owner only: an employee has no paid clicks. */
export interface ClickLoss { paid: number; reached: number }

/**
 * The top of Home: shown only while something is urgent, that is a failed conversion upload or alert that has reached the alert level,
 * or paid clicks that never reached the site. Each line says what and where. Nothing urgent renders nothing.
 */
export function IncidentBanner({ urgent, clickLoss }: { urgent: FixItem[]; clickLoss: ClickLoss | null }) {
  const count = urgent.length + (clickLoss ? 1 : 0);
  if (count === 0) return null;
  return (
    <section className="home-banner" role="alert" aria-label="เหตุด่วน">
      <b>{`มีเรื่องด่วน ${count} เรื่อง`}</b>
      <ul>
        {urgent.slice(0, 3).map((item) => <li key={item.id}>{`${item.brand}: ${item.message}`}</li>)}
        {clickLoss && <li>{`Google คิดเงิน ${num(clickLoss.paid)} คลิก แต่มาถึงเว็บเพียง ${num(clickLoss.reached)} คน`}</li>}
      </ul>
    </section>
  );
}
