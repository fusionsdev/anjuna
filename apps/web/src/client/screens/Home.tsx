import { CONVERSION_STALLED_HOURS, spendPeriodRange, type AlertsReportResponse, type ConversionsReportResponse, type FunnelReportResponse, type LifecycleBrandSummary, type PanelSpendReportResponse } from "@anjuna/contracts";
import { useEffect, useMemo, useState } from "react";
import { api, type BrandChecklists, type Me } from "../api";
import { DailyBars, dailySeries, type DailyCount } from "../components/DailyBars";
import { Sparkline } from "../components/Sparkline";
import { isDemoBrand } from "../brand-health";
import { clickLossWarning, delta, previousRange, scopeAlerts, scopeFunnel, scopeSpend, spendSeries, spendTotals } from "../home-metrics";
import { useBrandScope } from "../useBrandScope";
import { conversionsPath } from "./Conversions";
import { BrandRows } from "./home/BrandRows";
import { HumanTasks, type HumanTask } from "./home/HumanTasks";
import { IncidentBanner } from "./home/IncidentBanner";
import { NeedsFixList, fixItems, type HomePeriod } from "./home/NeedsFixList";
import { inApp, mark, num, type Value } from "./home/shared";
import { useBrandActions, type ActionBrand } from "../useBrandActions";
import "./Home.css";
import { AllBrandsNote } from "../components/AllBrandsNote";

export type { HomePeriod };
export type HomeTarget = "brands" | "new-brand" | "templates" | "funnel" | "alerts";

/** GET /api/spend?period= (owner only; cost in the account currency, cost_usd at the panel's rate). */
export type SpendReport = PanelSpendReportResponse;

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

const money = (symbol: "$" | "฿") => (value: Value): string => {
  const shown = mark(value);
  if (shown) return shown;
  const amount = value as number;
  const text = Math.abs(amount) >= 100 || Number.isInteger(amount) ? Math.round(Math.abs(amount)).toLocaleString("en-US") : Math.abs(amount).toFixed(2);
  return `${amount < 0 ? "−" : ""}${symbol}${text}`;
};
/** Revenue and profit: conversion values are USD. */
const usd = money("$");
/** Ad spend and cost per lead: the Google Ads accounts bill in baht. */
const thb = money("฿");

/** Two decimals like the Conversions page, so the card and the page show the same amount. */
const usdCents = (amount: number): string => `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** `revenue` is null when core withheld it for any row, so the ledger shows "—" and never a partial sum or `$0`. */
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
  if (report.rows.some((row) => row.revenue === null)) total.revenue = null;
  return total;
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

/** Leads whose brand has had no LeadsGate postback in the alert window: the leads still waiting for a result. */
function pendingLeads(report: AlertsReportResponse): number {
  return report.brands_without_postbacks.detail.brands.reduce((sum, b) => sum + b.leads, 0);
}

export function HomeScreen({ me, onGo }: { me: Me; onGo?: (target: HomeTarget) => void }) {
  const owner = me.role === "owner";
  const go = (target: HomeTarget) => () => onGo?.(target);
  const [period, setPeriod] = useState<HomePeriod>("today");
  // The raw reports are kept and the scope is applied on read, so a change of scope updates the numbers without a new request.
  const { inScopeId, hidesBrands } = useBrandScope();
  const [funnelRaw, setFunnelRaw] = useState<FunnelReportResponse | null | undefined>(undefined);
  const [previousRaw, setPreviousRaw] = useState<FunnelReportResponse | null | undefined>(undefined);
  const [alerts, setAlerts] = useState<AlertsReportResponse | null | undefined>(undefined);
  const [conversions, setConversions] = useState<ConversionsReportResponse | null | undefined>(undefined);
  const [daily, setDaily] = useState<DailyCount[] | null | undefined>(undefined);
  const [templates, setTemplates] = useState<Value>(undefined);
  // "name vN" by template version id, for the approve dialog. A sealed version is shared by every brand on it.
  const [templateLabels, setTemplateLabels] = useState<Record<string, string>>({});
  const [brands, setBrands] = useState<LifecycleBrandSummary[] | null | undefined>(undefined);
  const [checklists, setChecklists] = useState<BrandChecklists | null | undefined>(undefined);
  const [paused, setPaused] = useState<ReadonlySet<string> | null | undefined>(undefined);
  // The whole reports feed the brand rows; the totals above feed the tiles. Both come from the same answer.
  const [spendRaw, setSpendRaw] = useState<PanelSpendReportResponse | null | undefined>(undefined);
  // An action that changed a brand raises this, so the brand list and the batch checklist are read again.
  const [reloadKey, setReloadKey] = useState(0);
  const actions = useBrandActions({ onDone: () => setReloadKey((value) => value + 1) });

  // Funnel counts, spend, conversions and the daily bars follow the period switch. A late answer for an old period is dropped.
  useEffect(() => {
    let current = true;
    setFunnelRaw(undefined);
    setPreviousRaw(undefined);
    setSpendRaw(owner ? undefined : null);
    setConversions(undefined);
    setDaily(undefined);
    api.conversions({ period }).then((report) => current && setConversions(report), () => current && setConversions(null));
    // One bar pair per UTC day. `today` would be a single bar, so the chart shows the last 7 days.
    const days = spendPeriodRange(period === "today" ? "7d" : period);
    api.leadAggregates(days).then((report) => current && setDaily(dailySeries(report, days.from, days.to)), () => current && setDaily(null));
    api.funnel(periodRange(period)).then((report) => current && setFunnelRaw(report), () => current && setFunnelRaw(null));
    // The window before it feeds the deltas only. If it fails the deltas show a dash and the values stay.
    api.funnel(previousRange(periodRange(period))).then((report) => current && setPreviousRaw(report), () => current && setPreviousRaw(null));
    // The spend API answers 403 to an employee, so an employee never asks.
    if (owner) api.spend(period).then((report) => current && setSpendRaw(report), () => current && setSpendRaw(null));
    return () => { current = false; };
  }, [period, owner]);

  // Alerts and the to-do counts do not depend on the period.
  useEffect(() => {
    let current = true;
    api.alerts().then((report) => current && setAlerts(report), () => current && setAlerts(null));
    api.templates().then(
      (list) => {
        if (!current) return;
        setTemplates(list.templates.filter((t) => t.status === "awaiting_approval").length);
        setTemplateLabels(Object.fromEntries(list.templates.map((t) => [t.template_version_id, `${t.name} v${t.version}`])));
      },
      () => current && setTemplates(null),
    );
    // The brand list and one batch read of every live brand's checklist. The batch replaces one read per brand.
    api.lifecycleBrands().then(({ brands: list }) => current && setBrands(list), () => current && setBrands(null));
    api.checklists().then((batch) => current && setChecklists(batch), () => current && setChecklists(null));
    // Core pauses a brand while its factory status still reads live, so the paused set comes from core's brand list like on the Brands screen.
    api.brands().then((list) => current && setPaused(new Set(list.brands.filter((b) => b.status === "paused").map((b) => b.brand_id))), () => current && setPaused(null));
    return () => { current = false; };
  }, [reloadKey]);

  const funnelReport = useMemo(() => (funnelRaw ? scopeFunnel(funnelRaw, inScopeId) : funnelRaw), [funnelRaw, inScopeId]);
  const funnel = useMemo(() => (funnelReport === undefined ? undefined : funnelReport === null ? null : sumFunnel(funnelReport)), [funnelReport]);
  const previousFunnel = useMemo(() => (previousRaw === undefined ? undefined : previousRaw === null ? null : sumFunnel(scopeFunnel(previousRaw, inScopeId))), [previousRaw, inScopeId]);
  const spendReport = useMemo(() => (spendRaw ? scopeSpend(spendRaw, inScopeId) : spendRaw), [spendRaw, inScopeId]);
  const spend = spendReport === undefined ? undefined : spendReport === null ? null : spendTotals(spendReport);
  // The daily series has no brand, so a scope that hides brands shows no line.
  const spendDays = spendRaw && !hidesBrands ? spendSeries(spendRaw) : null;
  const scopedBrands = brands ? brands.filter((brand) => inScopeId(brand.brand_id)) : brands;
  // The alert items that name a brand follow the scope. The conversion items count every brand and say so ("ทุกแบรนด์").
  const scopedAlerts = useMemo(() => (alerts ? scopeAlerts(alerts, inScopeId) : alerts), [alerts, inScopeId]);
  const leads = funnel === undefined ? undefined : funnel?.leads ?? null;
  // Spend and cost per lead stay in baht. Profit subtracts the server's USD spend from USD revenue, never baht.
  const spendThb: Value = spend === undefined ? undefined : spend?.thb ?? null;
  const spendUsd: Value = spend === undefined ? undefined : spend?.usd ?? null;
  const revenue: Value = funnel === undefined ? undefined : funnel === null ? null : funnel.revenue;
  const costPerLead: Value = spendThb === undefined || leads === undefined ? undefined : spendThb === null || !leads ? null : spendThb / leads;
  const profit: Value = spendUsd === undefined || revenue === undefined ? undefined : spendUsd === null || revenue === null ? null : revenue - spendUsd;
  const pending: Value = scopedAlerts === undefined ? undefined : scopedAlerts === null ? null : pendingLeads(scopedAlerts);
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

  const fixes = fixItems(scopedAlerts, conversions, period);
  // The card links keep the period Home shows, like the fix list. The default period gives the bare /conversions.
  const allPath = conversionsPath({ period, status: "all", brand: null });
  const deadPath = conversionsPath({ period, status: "dead", brand: null });

  // Test sold is open for a live brand whose checklist lacks the row. Demo brands and brands the batch does not list are not counted.
  const testSoldBrands: LifecycleBrandSummary[] | null | undefined = brands === undefined || checklists === undefined ? undefined
    : brands === null || checklists === null ? null
      : (scopedBrands ?? []).filter((b) => b.status === "live" && !isDemoBrand(b) && checklists.brands[b.brand_id] && !checklists.brands[b.brand_id]!.checklist.some((row) => row.item === "test_sold"));
  const testSold: Value = testSoldBrands === undefined ? undefined : testSoldBrands === null ? null : testSoldBrands.length;
  const actionBrand = (b: LifecycleBrandSummary): ActionBrand => ({ id: b.brand_id, name: b.name ?? b.brand_id, domain: b.hostnames[0] ?? b.brand_id });
  const drafts: Value = brands === undefined ? undefined : brands === null ? null : (scopedBrands ?? []).filter((b) => b.status === "draft").length;
  const tasks: HumanTask[] = [
    { id: "test-sold", title: "ยืนยัน Test sold", count: testSold, unit: "แบรนด์", show: true, onOpen: () => { if (testSoldBrands) void actions.runBatch("test-sold", testSoldBrands.map(actionBrand)); else go("brands")(); } },
    { id: "templates", title: "อนุมัติเทมเพลต", count: templates, unit: "รายการ", show: owner, onOpen: go("templates") },
    { id: "drafts", title: "ร่างที่ยังไม่กดสร้าง", count: drafts, unit: "ร่าง", show: true, onOpen: go("new-brand") },
  ];

  // The banner: items that reached the alert level, and paid clicks that did not reach the site. Only the owner has paid clicks.
  const urgent = fixes.filter((item) => item.level === "bad");
  const paidClicks = owner && spend ? spend.clicks : null;
  const reached = funnel ? funnel.clicks : null;
  const clickLoss = paidClicks !== null && reached !== null && clickLossWarning(paidClicks, reached) ? { paid: paidClicks, reached } : null;

  return (
    <>
      <div className="home-head">
        <div>
          <h1>
            {owner
              ? `จ่ายค่าโฆษณา ${thb(spendThb)} ได้ ${num(leads)} ลีด ต้นทุนลีดละ ${thb(costPerLead)}`
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
        <IncidentBanner urgent={urgent} clickLoss={clickLoss} />
        <div className="home-grid2">
          <NeedsFixList alerts={scopedAlerts} conversions={conversions} fixes={fixes} onAlerts={go("alerts")} />
          <HumanTasks tasks={tasks} />
        </div>
        <div className="ledger" role="group" aria-label="สรุปตัวเลข">
          {owner ? (
            <>
              <div className="cell"><p className="k">ค่าโฆษณา</p><p className="v blue">{thb(spendThb)}</p>{typeof spendUsd === "number" && <p className="hint">{usd(spendUsd)}</p>}{spendDays && <Sparkline values={spendDays} label="ค่าโฆษณารายวัน" />}</div>
              <div className="cell"><p className="k">ต้นทุนต่อลีด</p><p className="v">{thb(costPerLead)}</p></div>
              <div className="cell"><p className="k">ลีด</p><p className="v">{num(leads)}</p><Delta now={leads} before={before((f) => f.leads)} /></div>
              <div className="cell"><p className="k">รายได้</p><p className="v">{usd(revenue)}</p><Delta now={revenue} before={before((f) => f.revenue)} /></div>
              <div className="cell"><p className="k">กำไร/ขาดทุน</p><p className={typeof profit === "number" ? (profit < 0 ? "v neg" : "v pos") : "v"}>{usd(profit)}</p></div>
            </>
          ) : (
            <>
              <div className="cell"><p className="k">ผู้เข้าเว็บ</p><p className="v">{num(field((f) => f.clicks))}</p><Delta now={field((f) => f.clicks)} before={before((f) => f.clicks)} /></div>
              <div className="cell"><p className="k">ลีด</p><p className="v">{num(leads)}</p><Delta now={leads} before={before((f) => f.leads)} /></div>
              <div className="cell"><p className="k">ขายได้</p><p className="v">{num(field((f) => f.sold))}</p><Delta now={field((f) => f.sold)} before={before((f) => f.sold)} /></div>
              <div className="cell"><p className="k">รอผล</p><p className="v">{num(pending)}</p></div>
              <div className="cell"><p className="k">คอนเวอร์ชันค้างส่ง</p><p className="v">{num(conversion((c) => c.totals.pending))}</p></div>
            </>
          )}
        </div>
        <BrandRows role={me.role} brands={scopedBrands} checklists={checklists} paused={paused} funnel={funnelReport} spend={spendReport} onAction={(action, brand) => void actions.run(action, { ...brand, templateLabel: brand.templateId ? templateLabels[brand.templateId] ?? null : null })} />
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
          {hidesBrands && <p className="hint">ลีดรายวันรวมทุกแบรนด์ ยังไม่แยกตามขอบเขตแบรนด์</p>}
          {daily === undefined && <p className="hint">…</p>}
          {daily === null && <p className="hint">— โหลดลีดรายวันไม่สำเร็จ</p>}
          {daily && <DailyBars days={daily} />}
        </section>
        <section className="panel home-conv" aria-label="คอนเวอร์ชัน">
          <div className="home-ptitle">
            <div className="home-ptitle-main"><h2>คอนเวอร์ชัน</h2><AllBrandsNote inline /></div>
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
      </div>
      {actions.view}
    </>
  );
}
