import { CONVERSION_STALLED_HOURS, spendPeriodRange, type AlertsReportResponse, type ConversionsReportResponse, type FunnelReportResponse, type SpendReportResponse } from "@anjuna/contracts";
import { useEffect, useState, type MouseEvent } from "react";
import { api, type Me } from "../api";
import { DailyBars, dailySeries, type DailyCount } from "../components/DailyBars";
import { delta, previousRange } from "../home-metrics";
import { isPlainLeftClick, navigate } from "../router";
import { conversionsPath } from "./Conversions";
import "./Home.css";

export type HomePeriod = "today" | "7d" | "30d";
export type HomeTarget = "brands" | "new-brand" | "templates" | "funnel" | "alerts";

/** GET /api/spend?period= (owner only, cost in USD; FUS-368). */
export type SpendReport = SpendReportResponse;

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

const mark = (value: Value): string | null => (value === undefined ? "…" : value === null ? "—" : null);
const num = (value: Value): string => mark(value) ?? Math.round(value as number).toLocaleString("en-US");
const usd = (value: Value): string => {
  const shown = mark(value);
  if (shown) return shown;
  const amount = value as number;
  const text = Math.abs(amount) >= 100 || Number.isInteger(amount) ? Math.round(Math.abs(amount)).toLocaleString("en-US") : Math.abs(amount).toFixed(2);
  return `${amount < 0 ? "−$" : "$"}${text}`;
};

/** Two decimals like the Conversions page, so the card and the page show the same amount. */
const usdCents = (amount: number): string => `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A plain left click moves inside the app; a ctrl-click or middle-click keeps the browser default (a new tab). */
const inApp = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  if (!isPlainLeftClick(event)) return;
  event.preventDefault();
  navigate(path);
};

/** `revenue` is null when core withheld it (every row null), so the ledger shows "—" and never `$0`. */
interface FunnelTotals { clicks: number; go: number; form: number; leads: number; sold: number; revenue: number | null }

function sumFunnel(report: FunnelReportResponse): FunnelTotals {
  const total: FunnelTotals = { clicks: 0, go: 0, form: 0, leads: 0, sold: 0, revenue: 0 };
  for (const row of report.rows) {
    total.clicks += row.clicks;
    total.go += row.go_count;
    total.form += row.form_views;
    total.leads += row.submits;
    total.sold += row.sold;
    total.revenue = (total.revenue ?? 0) + (row.revenue ?? 0);
  }
  if (report.rows.length > 0 && report.rows.every((row) => row.revenue === null)) total.revenue = null;
  return total;
}

/** No AdKit rows for the period means nothing was synced, not that nothing was spent. */
function spendTotals(report: SpendReport): { cost: number; clicks: number } | null {
  if (report.brands.length === 0 && report.totals.cost === 0 && report.totals.clicks === 0) return null;
  return { cost: report.totals.cost, clicks: report.totals.clicks };
}

/** Change against the previous window, under a ledger value. Every metric using it is good when up. */
function Delta({ now, before }: { now: Value; before: Value }) {
  const d = delta(now, before);
  if (!d) return null;
  return <p className={`d${d.dir === "up" ? " pos" : d.dir === "down" ? " neg" : ""}`}>{d.text}</p>;
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

/** An item with a `path` links there; one without opens the alerts screen. */
interface FixItem { id: string; level: "bad" | "warn"; brand: string; message: string; path?: string }

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

const level = (state: "ok" | "warn" | "alert"): "bad" | "warn" => (state === "alert" ? "bad" : "warn");

/** The conversion items. The links keep the period Home shows; stalled rows count at any age, so theirs uses the widest list. */
function conversionItems(report: ConversionsReportResponse, period: HomePeriod): FixItem[] {
  const items: FixItem[] = [];
  if (report.totals.dead > 0) items.push({ id: "conversions:dead", level: "bad", brand: "ทุกแบรนด์", message: `คอนเวอร์ชันส่งไม่ได้ ${report.totals.dead} รายการ`, path: conversionsPath({ period, status: "dead", brand: null }) });
  if (report.stalled > 0) items.push({ id: "conversions:stalled", level: "warn", brand: "ทุกแบรนด์", message: `คอนเวอร์ชันค้างเกิน ${CONVERSION_STALLED_HOURS} ชม. ${report.stalled} รายการ`, path: conversionsPath({ period: "30d", status: "pending", brand: null }) });
  return items;
}

/** Each source adds its items once it answered: `undefined` is loading and `null` is failed, and neither blocks the other. */
function fixItems(alerts: AlertsReportResponse | null | undefined, conversions: ConversionsReportResponse | null | undefined, period: HomePeriod): FixItem[] {
  const items = [...(conversions ? conversionItems(conversions, period) : []), ...(alerts ? alertItems(alerts, (conversions?.stalled ?? 0) > 0) : [])];
  return items.sort((a, b) => Number(b.level === "bad") - Number(a.level === "bad"));
}

/** The stalled alert counts the same pending rows as the conversions report, so `stalledElsewhere` drops it and one entry remains. */
function alertItems(report: AlertsReportResponse, stalledElsewhere: boolean): FixItem[] {
  const items: FixItem[] = [];
  const stalled = report.conversion_stalled;
  if (stalled.state !== "ok" && stalled.detail.stuck_count > 0 && !stalledElsewhere) {
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
  return items;
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
  const [previousFunnel, setPreviousFunnel] = useState<FunnelTotals | null | undefined>(undefined);
  const [spend, setSpend] = useState<{ cost: number; clicks: number } | null | undefined>(undefined);
  const [alerts, setAlerts] = useState<AlertsReportResponse | null | undefined>(undefined);
  const [conversions, setConversions] = useState<ConversionsReportResponse | null | undefined>(undefined);
  const [daily, setDaily] = useState<DailyCount[] | null | undefined>(undefined);
  const [testSold, setTestSold] = useState<Value>(undefined);
  const [templates, setTemplates] = useState<Value>(undefined);
  const [drafts, setDrafts] = useState<Value>(undefined);

  // Funnel counts, spend, conversions and the daily bars follow the period switch. A late answer for an old period is dropped.
  useEffect(() => {
    let current = true;
    setFunnel(undefined);
    setPreviousFunnel(undefined);
    setSpend(owner ? undefined : null);
    setConversions(undefined);
    setDaily(undefined);
    api.conversions({ period }).then((report) => current && setConversions(report), () => current && setConversions(null));
    // One bar pair per UTC day. `today` would be a single bar, so the chart shows the last 7 days.
    const days = spendPeriodRange(period === "today" ? "7d" : period);
    api.leadAggregates(days).then((report) => current && setDaily(dailySeries(report, days.from, days.to)), () => current && setDaily(null));
    api.funnel(periodRange(period)).then((report) => current && setFunnel(sumFunnel(report)), () => current && setFunnel(null));
    // The window before it feeds the deltas only. If it fails the deltas show a dash and the values stay.
    api.funnel(previousRange(periodRange(period))).then((report) => current && setPreviousFunnel(sumFunnel(report)), () => current && setPreviousFunnel(null));
    // The spend API answers 403 to an employee, so an employee never asks.
    if (owner) api.spend(period).then((report) => current && setSpend(spendTotals(report)), () => current && setSpend(null));
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
  const revenue: Value = funnel === undefined ? undefined : funnel === null ? null : funnel.revenue;
  const costPerLead: Value = spendCost === undefined || leads === undefined ? undefined : spendCost === null || !leads ? null : spendCost / leads;
  const profit: Value = spendCost === undefined || revenue === undefined ? undefined : spendCost === null || revenue === null ? null : revenue - spendCost;
  const pending: Value = alerts === undefined ? undefined : alerts === null ? null : pendingLeads(alerts);
  const field = (pick: (f: FunnelTotals) => number): Value => (funnel === undefined ? undefined : funnel === null ? null : pick(funnel));
  const before = (pick: (f: FunnelTotals) => Value): Value => (previousFunnel === undefined ? undefined : previousFunnel === null ? null : pick(previousFunnel));
  const conversion = (pick: (c: ConversionsReportResponse) => number): Value => (conversions === undefined ? undefined : conversions === null ? null : pick(conversions));
  // Core sends value_totals to the owner only; the card still checks the role so no other session shows it.
  const uploadedValue = owner && conversions ? conversions.value_totals?.uploaded : undefined;

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

  const fixes = fixItems(alerts, conversions, period);
  // The card links keep the period Home shows, like the fix list. The default period gives the bare /conversions.
  const allPath = conversionsPath({ period, status: "all", brand: null });
  const deadPath = conversionsPath({ period, status: "dead", brand: null });
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
              <div className="cell"><p className="k">รายได้</p><p className="v">{usd(revenue)}</p><Delta now={revenue} before={before((f) => f.revenue)} /></div>
              <div className="cell"><p className="k">กำไร/ขาดทุน</p><p className={typeof profit === "number" ? (profit < 0 ? "v neg" : "v pos") : "v"}>{usd(profit)}</p></div>
            </>
          ) : (
            <>
              <div className="cell"><p className="k">ผู้เข้าเว็บ</p><p className="v">{num(field((f) => f.clicks))}</p><Delta now={field((f) => f.clicks)} before={before((f) => f.clicks)} /></div>
              <div className="cell"><p className="k">ลีด</p><p className="v">{num(leads)}</p><Delta now={leads} before={before((f) => f.leads)} /></div>
              <div className="cell"><p className="k">ขายได้</p><p className="v">{num(field((f) => f.sold))}</p><Delta now={field((f) => f.sold)} before={before((f) => f.sold)} /></div>
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
        <section className="panel" aria-label="ลีดรายวัน">
          <div className="home-ptitle">
            <h2>ลีดรายวัน</h2>
          </div>
          {daily === undefined && <p className="hint">…</p>}
          {daily === null && <p className="hint">—</p>}
          {daily && <DailyBars days={daily} />}
        </section>
        <div className="home-grid2">
          <section className="panel home-conv" aria-label="คอนเวอร์ชัน">
            <div className="home-ptitle">
              <h2>คอนเวอร์ชัน</h2>
              <a className="btn" href={allPath} onClick={inApp(allPath)}>ดูทั้งหมด</a>
            </div>
            <div className="ledger" role="group" aria-label="สรุปคอนเวอร์ชัน">
              <div className="cell"><p className="k">ส่งแล้ว</p><p className="v">{num(conversion((c) => c.totals.uploaded))}</p></div>
              <div className="cell"><p className="k">ค้างส่ง</p><p className="v">{num(conversion((c) => c.totals.pending))}</p></div>
              <a className="cell" href={deadPath} onClick={inApp(deadPath)}><p className="k">ส่งไม่ได้</p><p className="v">{num(conversion((c) => c.totals.dead))}</p></a>
              <div className="cell"><p className="k">{`ค้างเกิน ${CONVERSION_STALLED_HOURS} ชม.`}</p><p className="v">{num(conversion((c) => c.stalled))}</p></div>
              {typeof uploadedValue === "number" && <div className="cell"><p className="k">มูลค่าที่ส่งแล้ว</p><p className="v">{usdCents(uploadedValue)}</p></div>}
            </div>
          </section>
          <section className="panel" aria-label="ต้องแก้">
            <div className="home-ptitle">
              <h2>ต้องแก้</h2>
              <button type="button" className="btn" onClick={go("alerts")}>ดูทั้งหมด</button>
            </div>
            {alerts === undefined && <p className="hint">…</p>}
            {alerts === null && <p className="hint">— โหลดการแจ้งเตือนไม่สำเร็จ</p>}
            {conversions === null && <p className="hint">— โหลดคอนเวอร์ชันไม่สำเร็จ</p>}
            {/* Each source shows its items on its own. "Nothing to fix" needs both to have answered, since a missing source may hide items. */}
            {alerts && conversions === undefined && fixes.length === 0 && <p className="hint">…</p>}
            {alerts && conversions && fixes.length === 0 && <p className="hint">ไม่มีเรื่องที่ต้องแก้</p>}
            {fixes.slice(0, 4).map((item) => (
              <div className="home-item" key={item.id}>
                <span className="dot" style={{ background: item.level === "bad" ? "var(--bad)" : "var(--leak)" }} aria-hidden="true" />
                <div className="t"><b style={{ fontWeight: 500 }}>{item.brand}</b><span>{item.message}</span></div>
                {item.path
                  ? <a className="btn" href={item.path} onClick={inApp(item.path)}>ดูรายละเอียด</a>
                  : <button type="button" className="btn" onClick={go("alerts")}>ดูรายละเอียด</button>}
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
