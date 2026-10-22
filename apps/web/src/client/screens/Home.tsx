import type { AlertsReportResponse, FunnelReportResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api, type Me } from "../api";
import "./Home.css";

export type HomePeriod = "today" | "7d" | "30d";
export type HomeTarget = "brands" | "new-brand" | "templates" | "funnel" | "alerts";

/** GET /api/spend?period= (owner only). The shape is fixed by the C2 contract. */
export interface SpendReport {
  period: string;
  from: string;
  to: string;
  totals: { cost: number; clicks: number; impressions: number };
  brands: Array<{ brand_id: string; cost: number; clicks: number; impressions: number; updated_at: string }>;
}

/** A number, `null` for data that could not be read (shown as "—"), `undefined` while it loads (shown as "…"). */
type Value = number | null | undefined;

const PERIODS: Array<[HomePeriod, string]> = [["today", "วันนี้"], ["7d", "7 วัน"], ["30d", "30 วัน"]];
const PERIOD_DAYS: Record<HomePeriod, number> = { today: 1, "7d": 7, "30d": 30 };

const shiftDay = (dayText: string, days: number): string => {
  const date = new Date(`${dayText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** UTC days like the Funnel screen: the window ends after today and `to` is exclusive. */
function periodRange(period: HomePeriod): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  return { from: `${shiftDay(today, 1 - PERIOD_DAYS[period])}T00:00:00.000Z`, to: `${shiftDay(today, 1)}T00:00:00.000Z` };
}

// C2 adds `api.spend`. Until it is merged this reads as "no spend data", which the screen shows as "—".
async function loadSpend(period: HomePeriod): Promise<SpendReport> {
  const spend = (api as unknown as { spend?: (period: HomePeriod) => Promise<SpendReport> }).spend;
  if (!spend) throw new Error("spend api is not available");
  return spend(period);
}

const mark = (value: Value): string | null => (value === undefined ? "…" : value === null ? "—" : null);
const num = (value: Value): string => mark(value) ?? Math.round(value as number).toLocaleString("en-US");
const usd = (value: Value): string => {
  const shown = mark(value);
  if (shown) return shown;
  const amount = value as number;
  const text = Math.abs(amount) >= 100 || Number.isInteger(amount) ? Math.round(Math.abs(amount)).toLocaleString("en-US") : Math.abs(amount).toFixed(2);
  return `${amount < 0 ? "−$" : "$"}${text}`;
};

interface FunnelTotals { clicks: number; go: number; form: number; leads: number; sold: number; revenue: number }

function sumFunnel(report: FunnelReportResponse): FunnelTotals {
  const total: FunnelTotals = { clicks: 0, go: 0, form: 0, leads: 0, sold: 0, revenue: 0 };
  for (const row of report.rows) {
    total.clicks += row.clicks;
    total.go += row.go_count;
    total.form += row.form_views;
    total.leads += row.submits;
    total.sold += row.sold;
    total.revenue += row.revenue;
  }
  return total;
}

/** No AdKit rows for the period means nothing was synced, not that nothing was spent. */
function spendTotals(report: SpendReport): { cost: number; clicks: number } | null {
  if (report.brands.length === 0 && report.totals.cost === 0 && report.totals.clicks === 0) return null;
  return { cost: report.totals.cost, clicks: report.totals.clicks };
}

interface Stage { label: string; value: Value; paid?: boolean }

/** The stage with the largest share lost from the stage before it. Needs two readable stages in a row. */
function biggestLeak(stages: Stage[]): number {
  let worst = -1;
  let worstDrop = 0;
  for (let i = 1; i < stages.length; i++) {
    const before = stages[i - 1]!.value;
    const here = stages[i]!.value;
    if (typeof before !== "number" || typeof here !== "number" || before <= 0) continue;
    const drop = 1 - here / before;
    if (drop > worstDrop) { worst = i; worstDrop = drop; }
  }
  return worst;
}

const dropText = (before: Value, here: Value): string =>
  typeof before === "number" && typeof here === "number" && before > 0 ? `หลุด ${Math.max(0, Math.round((1 - here / before) * 100))}%` : "—";

function leakNote(stages: Stage[], leak: number): string | null {
  if (leak < 1) return null;
  const before = stages[leak - 1]!;
  const here = stages[leak]!;
  const lost = (before.value as number) - (here.value as number);
  const pct = Math.round((lost / (before.value as number)) * 100);
  if (before.paid) return `Google คิดเงิน ${num(before.value)} คลิก มาถึงเว็บจริง ${num(here.value)} คน หายไป ${num(lost)} คลิก (${pct}%)`;
  return `หลุดมากที่สุดที่ขั้น "${before.label}" ไป "${here.label}": จาก ${num(before.value)} เหลือ ${num(here.value)} (${pct}%)`;
}

interface FixItem { id: string; level: "bad" | "warn"; brand: string; message: string }

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

function fixItems(report: AlertsReportResponse): FixItem[] {
  const level = (state: "ok" | "warn" | "alert"): "bad" | "warn" => (state === "alert" ? "bad" : "warn");
  const items: FixItem[] = [];
  const stalled = report.conversion_stalled;
  if (stalled.state !== "ok" && stalled.detail.stuck_count > 0) {
    items.push({ id: "stalled", level: level(stalled.state), brand: "ทุกแบรนด์", message: `${stalled.detail.stuck_count} คอนเวอร์ชันยังไม่ถูกส่งเกิน ${stalled.detail.max_hours} ชั่วโมง` });
  }
  const noPostback = report.brands_without_postbacks;
  if (noPostback.state !== "ok") {
    for (const b of noPostback.detail.brands) items.push({ id: `postback:${b.brand}`, level: level(noPostback.state), brand: b.brand, message: `${b.leads} ลีดยังไม่มีผลจาก LeadsGate เกิน ${noPostback.detail.window_hours} ชั่วโมง` });
  }
  const submitErrors = report.submit_error_rate;
  if (submitErrors.state !== "ok") {
    for (const s of submitErrors.detail.samples) items.push({ id: `submit:${s.brand}`, level: level(submitErrors.state), brand: s.brand, message: `ส่งฟอร์มผิดพลาด ${percent(s.rate)} (${s.errors} จาก ${s.submits + s.errors} ครั้ง)` });
  }
  const rejects = report.reject_rate;
  if (rejects.state !== "ok") {
    for (const b of rejects.detail.brands) items.push({ id: `reject:${b.brand}`, level: level(rejects.state), brand: b.brand, message: `อัตรา reject ${percent(b.rate)} สูงกว่าค่าปกติ ${percent(rejects.detail.warn_at)}` });
  }
  return items.sort((a, b) => Number(b.level === "bad") - Number(a.level === "bad"));
}

/** Leads whose brand has had no LeadsGate postback in the alert window: the leads still waiting for a result. */
function pendingLeads(report: AlertsReportResponse): number {
  return report.brands_without_postbacks.detail.brands.reduce((sum, b) => sum + b.leads, 0);
}

export function HomeScreen({ me, onGo }: { me: Me; onGo?: (target: HomeTarget) => void }) {
  const owner = me.role === "owner";
  const go = (target: HomeTarget) => () => onGo?.(target);
  const [period, setPeriod] = useState<HomePeriod>("7d");
  const [funnel, setFunnel] = useState<FunnelTotals | null | undefined>(undefined);
  const [spend, setSpend] = useState<{ cost: number; clicks: number } | null | undefined>(undefined);
  const [alerts, setAlerts] = useState<AlertsReportResponse | null | undefined>(undefined);
  const [testSold, setTestSold] = useState<Value>(undefined);
  const [templates, setTemplates] = useState<Value>(undefined);
  const [drafts, setDrafts] = useState<Value>(undefined);

  // Funnel counts and spend follow the period switch. A late answer for an old period is dropped.
  useEffect(() => {
    let current = true;
    setFunnel(undefined);
    setSpend(owner ? undefined : null);
    api.funnel(periodRange(period)).then((report) => current && setFunnel(sumFunnel(report)), () => current && setFunnel(null));
    // The spend API answers 403 to an employee, so an employee never asks.
    if (owner) loadSpend(period).then((report) => current && setSpend(spendTotals(report)), () => current && setSpend(null));
    return () => { current = false; };
  }, [period, owner]);

  // Alerts and the to-do counts do not depend on the period.
  useEffect(() => {
    let current = true;
    api.alerts().then((report) => current && setAlerts(report), () => current && setAlerts(null));
    api.templates().then(
      (list) => current && setTemplates(list.templates.filter((t) => t.status === "awaiting_approval").length),
      () => current && setTemplates(null),
    );
    api.lifecycleBrands().then(async ({ brands }) => {
      if (!current) return;
      setDrafts(brands.filter((b) => b.status === "draft").length);
      const live = brands.filter((b) => b.status === "live");
      const lists = await Promise.allSettled(live.map((b) => api.checklist(b.brand_id)));
      if (!current) return;
      if (lists.some((l) => l.status === "rejected")) return setTestSold(null);
      setTestSold(lists.filter((l) => l.status === "fulfilled" && !l.value.checklist.some((row) => row.item === "test_sold")).length);
    }, () => { if (current) { setDrafts(null); setTestSold(null); } });
    return () => { current = false; };
  }, []);

  const leads = funnel === undefined ? undefined : funnel?.leads ?? null;
  const spendCost: Value = spend === undefined ? undefined : spend?.cost ?? null;
  const revenue: Value = funnel === undefined ? undefined : funnel?.revenue ?? null;
  const costPerLead: Value = spendCost === undefined || leads === undefined ? undefined : spendCost === null || !leads ? null : spendCost / leads;
  const profit: Value = spendCost === undefined || revenue === undefined ? undefined : spendCost === null || revenue === null ? null : revenue - spendCost;
  const pending: Value = alerts === undefined ? undefined : alerts === null ? null : pendingLeads(alerts);
  const field = (pick: (f: FunnelTotals) => number): Value => (funnel === undefined ? undefined : funnel === null ? null : pick(funnel));

  const stages: Stage[] = [
    ...(owner ? [{ label: "คลิกที่จ่าย", value: spend === undefined ? undefined : spend?.clicks ?? null, paid: true }] : []),
    { label: "ถึงเว็บ", value: field((f) => f.clicks) },
    { label: "ถึง /go", value: field((f) => f.go) },
    { label: "เปิดฟอร์ม", value: field((f) => f.form) },
    { label: "ลีด", value: field((f) => f.leads) },
    { label: "ขายได้", value: field((f) => f.sold) },
  ];
  const leak = biggestLeak(stages);
  const note = leakNote(stages, leak);
  const biggest = Math.max(1, ...stages.map((s) => (typeof s.value === "number" ? s.value : 0)));

  const fixes = alerts ? fixItems(alerts) : [];
  const todos: Array<{ id: string; title: string; count: Value; unit: string; target: HomeTarget; show: boolean }> = [
    { id: "test-sold", title: "ยืนยัน Test sold", count: testSold, unit: "แบรนด์", target: "brands", show: true },
    { id: "templates", title: "อนุมัติเทมเพลต", count: templates, unit: "รายการ", target: "templates", show: owner },
    { id: "drafts", title: "ร่างที่ยังไม่กดสร้าง", count: drafts, unit: "ร่าง", target: "new-brand", show: true },
  ];

  return (
    <>
      <div className="home-head">
        <div>
          <h1>
            {owner
              ? `จ่ายค่าโฆษณา ${usd(spendCost)} ได้ ${num(leads)} ลีด ต้นทุนลีดละ ${usd(costPerLead)}`
              : `ผู้เข้าเว็บ ${num(field((f) => f.clicks))} คน ได้ ${num(leads)} ลีด ขายได้ ${num(field((f) => f.sold))}`}
          </h1>
          <p className="home-sub">{owner ? "ทุกแบรนด์ใน aduplift ค่าโฆษณาจาก AdKit อัปเดตทุกชั่วโมง" : "ทุกแบรนด์ใน aduplift"}</p>
        </div>
        <div className="home-actions">
          <div className="seg" role="group" aria-label="ช่วงเวลา">
            {PERIODS.map(([key, label]) => (
              <button key={key} type="button" aria-pressed={period === key} onClick={() => setPeriod(key)}>{label}</button>
            ))}
          </div>
          <button type="button" className="btn pri" onClick={go("new-brand")}>+ สร้างแบรนด์ใหม่</button>
        </div>
      </div>
      <div className="home-stack">
        <div className="ledger" role="group" aria-label="สรุปตัวเลข">
          {owner ? (
            <>
              <div className="cell"><p className="k">ค่าโฆษณา</p><p className="v blue">{usd(spendCost)}</p></div>
              <div className="cell"><p className="k">ต้นทุนต่อลีด</p><p className="v">{usd(costPerLead)}</p></div>
              <div className="cell"><p className="k">รายได้</p><p className="v">{usd(revenue)}</p></div>
              <div className="cell"><p className="k">กำไร/ขาดทุน</p><p className={typeof profit === "number" ? (profit < 0 ? "v neg" : "v pos") : "v"}>{usd(profit)}</p></div>
            </>
          ) : (
            <>
              <div className="cell"><p className="k">ผู้เข้าเว็บ</p><p className="v">{num(field((f) => f.clicks))}</p></div>
              <div className="cell"><p className="k">ลีด</p><p className="v">{num(leads)}</p></div>
              <div className="cell"><p className="k">ขายได้</p><p className="v">{num(field((f) => f.sold))}</p></div>
              <div className="cell"><p className="k">รอผล</p><p className="v">{num(pending)}</p></div>
            </>
          )}
        </div>
        <section className="panel" aria-label="เงินไหลไปถึงไหน">
          <div className="home-ptitle">
            <h2>{owner ? "เงินไหลไปถึงไหน" : "คนไหลไปถึงไหน"}</h2>
            <button type="button" className="btn" onClick={go("funnel")}>แยกตามแบรนด์</button>
          </div>
          <div className="home-flow" style={{ ["--stages" as string]: stages.length }}>
            {stages.map((stage, i) => (
              <div key={stage.label} className={`home-stage${stage.paid ? " paid" : ""}${i === leak ? " leak" : ""}${typeof stage.value === "number" ? "" : " gap"}`}>
                <div className="home-bar" style={{ height: `${Math.max(6, Math.round(((typeof stage.value === "number" ? stage.value : 0) / biggest) * 120))}px` }} />
                <p className="home-n">{num(stage.value)}</p>
                <p className="home-l">{stage.label}</p>
              </div>
            ))}
          </div>
          <div className="home-drops" style={{ ["--stages" as string]: stages.length }}>
            {stages.map((stage, i) => (i ? <span key={stage.label} className={i === leak ? "amb" : ""}>{dropText(stages[i - 1]!.value, stage.value)}</span> : <span key={stage.label} />))}
          </div>
          {note && (
            <p className="note">
              {note}
              <button type="button" className="btn" style={{ marginInlineStart: 6 }} onClick={go("funnel")}>ดูในฟันเนล</button>
            </p>
          )}
        </section>
        <div className="home-grid2">
          <section className="panel" aria-label="ต้องแก้">
            <div className="home-ptitle">
              <h2>ต้องแก้</h2>
              <button type="button" className="btn" onClick={go("alerts")}>ดูทั้งหมด</button>
            </div>
            {alerts === undefined && <p className="hint">…</p>}
            {alerts === null && <p className="hint">— โหลดการแจ้งเตือนไม่สำเร็จ</p>}
            {alerts && fixes.length === 0 && <p className="hint">ไม่มีเรื่องที่ต้องแก้</p>}
            {fixes.slice(0, 4).map((item) => (
              <div className="home-item" key={item.id}>
                <span className="dot" style={{ background: item.level === "bad" ? "var(--bad)" : "var(--leak)" }} aria-hidden="true" />
                <div className="t"><b style={{ fontWeight: 500 }}>{item.brand}</b><span>{item.message}</span></div>
                <button type="button" className="btn" onClick={go("alerts")}>ดูรายละเอียด</button>
              </div>
            ))}
          </section>
          <section className="panel" aria-label="งานที่ต้องใช้คน">
            <h2>งานที่ต้องใช้คน</h2>
            {todos.filter((todo) => todo.show).map((todo) => (
              <div className="home-item" key={todo.id}>
                <div className="t">{todo.title}<span>{todo.count === 0 ? "ไม่มีงานค้าง" : `${num(todo.count)} ${todo.unit}`}</span></div>
                {todo.count !== 0 && <button type="button" className="btn" onClick={go(todo.target)}>เปิด</button>}
              </div>
            ))}
            <p className="hint" style={{ marginTop: 8 }}>ระบบทำที่เหลือให้เองแล้ว</p>
          </section>
        </div>
      </div>
    </>
  );
}
