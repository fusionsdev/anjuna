import { CONVERSIONS_MAX_LIMIT, type AlertsReportResponse, type BrandSummary, type ConversionsReportResponse, type FunnelReportResponse, type LifecycleBrandSummary, type PanelSpendReportResponse, type TemplateVersionSummary } from "@anjuna/contracts";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleDollarSign, CreditCard, Globe2, ListTodo, TrendingUp, UsersRound } from "lucide-react";
import { api, type BrandChecklists, type Me } from "../api";
import { hydrateAlertStates, useAlertSession } from "../alerts-session";
import { hostnameBrand } from "../alert-incidents";
import { buildBrandLabels } from "../brand-labels";
import { Chip, type ChipTone } from "../components/Chip";
import { EmptyState } from "../components/EmptyState";
import { scopeAlerts, scopeFunnel, scopeSpend, spendTotals } from "../home-metrics";
import { listedInBrands } from "../task-counts";
import { CLICK_PERIOD, DEAD_PERIOD, clickRange, clickTotals, taskRows, type TaskCategory, type TaskLevel, type TaskRow } from "../task-rows";
import { useBrandScope } from "../useBrandScope";
import { inApp } from "./home/shared";
import { routePath } from "../router";
import "./Home.css";

type Filter = "all" | "urgent" | TaskCategory;

const LEVEL_LABEL: Record<TaskLevel, string> = { urgent: "ด่วน", todo: "รอทำ", system: "ระบบ" };
const LEVEL_TONE: Record<TaskLevel, ChipTone> = { urgent: "danger", todo: "warning", system: "info" };
const FILTERS: Array<[Filter, string]> = [["all", "ทั้งหมด"], ["urgent", "ด่วน"], ["brand", "แบรนด์"], ["template", "เทมเพลต"], ["system", "ระบบ"]];
const matches = (filter: Filter, row: TaskRow): boolean => filter === "all" || (filter === "urgent" ? row.level === "urgent" : row.category === filter);

/** undefined while loading, null when the read failed. */
type Loaded<T> = T | null | undefined;

/**
 * งานรอทำ (`/`): one list of what needs a person, most urgent first. The rows come from task-rows.ts, the same code
 * GET /api/nav/counts counts for the sidebar badge, so the badge equals the rows here under the same scope.
 * onCounted gets the row count once every source has answered, so the shell can set the badge to the rows shown.
 */
export function HomeScreen({ me, onCounted }: { me: Me; onCounted?: (count: number) => void }) {
  const owner = me.role === "owner";
  const { inScopeId, scope } = useBrandScope();
  const [filter, setFilter] = useState<Filter>("all");
  const [alerts, setAlerts] = useState<Loaded<AlertsReportResponse>>(undefined);
  const [statesRead, setStatesRead] = useState<"loading" | "ready" | "error">("loading");
  const states = useAlertSession();
  const [brands, setBrands] = useState<Loaded<LifecycleBrandSummary[]>>(undefined);
  const [runtime, setRuntime] = useState<Loaded<BrandSummary[]>>(undefined);
  const [checklists, setChecklists] = useState<Loaded<BrandChecklists>>(undefined);
  const [templates, setTemplates] = useState<Loaded<TemplateVersionSummary[]>>(owner ? undefined : null);
  const [dead, setDead] = useState<Loaded<ConversionsReportResponse>>(undefined);
  // Today's paid clicks and funnel clicks for the click loss row. The owner's only: an employee has no spend report.
  const [spend, setSpend] = useState<Loaded<PanelSpendReportResponse>>(owner ? undefined : null);
  const [funnel, setFunnel] = useState<Loaded<FunnelReportResponse>>(owner ? undefined : null);

  useEffect(() => {
    let current = true;
    api.alerts().then((report) => current && setAlerts(report), () => current && setAlerts(null));
    // The stored acknowledge and close states decide which alerts are still open, like the Alerts screen.
    api.alertStates().then((rows) => { if (current) { hydrateAlertStates(rows); setStatesRead("ready"); } }, () => current && setStatesRead("error"));
    api.lifecycleBrands().then(({ brands: list }) => current && setBrands(list), () => current && setBrands(null));
    // Core's list gives the paused status and the hostnames. It is a source below: until it answers, paused brands still count.
    api.brands().then((list) => current && setRuntime(list.brands), () => current && setRuntime(null));
    api.checklists().then((batch) => current && setChecklists(batch), () => current && setChecklists(null));
    // Template approval is the owner's work, so an employee never asks.
    if (owner) api.templates().then((list) => current && setTemplates(list.templates), () => current && setTemplates(null));
    api.conversions({ period: DEAD_PERIOD, status: "dead", limit: CONVERSIONS_MAX_LIMIT }).then((report) => current && setDead(report), () => current && setDead(null));
    if (owner) {
      api.spend(CLICK_PERIOD).then((report) => current && setSpend(report), () => current && setSpend(null));
      api.funnel(clickRange(new Date())).then((report) => current && setFunnel(report), () => current && setFunnel(null));
    }
    return () => { current = false; };
  }, [owner]);

  const domains = useMemo(() => buildBrandLabels(brands ?? null, runtime ?? null), [brands, runtime]);
  const rows = useMemo(() => {
    // Core's status per brand, as GET /api/nav/counts passes it, so both list the same brands.
    const statusOf = new Map((runtime ?? []).map((b) => [b.brand_id, b.status as string]));
    const listed = brands ? brands.filter((b) => listedInBrands(scope, b, statusOf.get(b.brand_id))) : null;
    return taskRows({
      owner,
      alerts: alerts && statesRead === "ready" ? { report: scopeAlerts(alerts, inScopeId), states, brandOfHostname: hostnameBrand(domains) } : null,
      brands: listed,
      checklists: checklists ? checklists.brands : null,
      templates: templates ?? null,
      dead: dead ?? null,
      clicks: spend && funnel ? clickTotals(spend, funnel, inScopeId) : null,
      domains,
    });
  }, [owner, alerts, statesRead, states, brands, runtime, checklists, templates, dead, spend, funnel, domains, scope, inScopeId]);

  // A source still loading or failed says so on its own line, so a short list never reads as "nothing to do".
  const sources: Array<[string, unknown]> = [
    ["การแจ้งเตือน", alerts === null || statesRead === "error" ? null : alerts === undefined || statesRead === "loading" ? undefined : alerts],
    ["รายชื่อแบรนด์", brands],
    ["สถานะแบรนด์", runtime],
    ["เช็กลิสต์ของแบรนด์", checklists],
    ...(owner ? [["เทมเพลต", templates] as [string, unknown]] : []),
    ["รายการส่งยอดขาย", dead],
    ...(owner ? [["ยอดคลิกโฆษณาวันนี้", spend === null || funnel === null ? null : spend === undefined || funnel === undefined ? undefined : spend] as [string, unknown]] : []),
  ];
  const failed = sources.filter(([, value]) => value === null).map(([name]) => name);
  const loading = sources.some(([, value]) => value === undefined);
  const complete = !loading && failed.length === 0;
  const urgent = rows.filter((row) => row.level === "urgent").length;
  const shown = rows.filter((row) => matches(filter, row));
  // Mission Control reuses the reports already fetched for the task list. No new calls,
  // no synthetic KPIs, and the same saved brand scope as every existing report.
  const scopedFunnel = funnel ? scopeFunnel(funnel, inScopeId) : null;
  const scopedSpend = spend ? spendTotals(scopeSpend(spend, inScopeId)) : null;
  const funnelSummary = scopedFunnel ? {
    leads: scopedFunnel.rows.reduce((sum, item) => sum + item.submits, 0),
    sold: scopedFunnel.rows.reduce((sum, item) => sum + item.sold, 0),
    revenue: scopedFunnel.rows.some((item) => item.revenue === null)
      ? null : scopedFunnel.rows.reduce((sum, item) => sum + (item.revenue ?? 0), 0),
  } : null;
  const scopedBrands = brands?.filter((brand) => listedInBrands(scope, brand, runtime?.find((item) => item.brand_id === brand.brand_id)?.status));
  const activeBrands = scopedBrands ? scopedBrands.filter((brand) => brand.status === "live").length : null;
  const portfolio = scopedBrands?.filter((brand) => brand.status !== "retired").slice(0, 5) ?? [];
  const shownNumber = (value: number | null | undefined, unit = "") => value === null || value === undefined ? "—" : unit + value.toLocaleString("en-US", { maximumFractionDigits: unit ? 2 : 0 });


  // Every source answered: the row count is the badge. A partial list never replaces it.
  useEffect(() => {
    if (complete) onCounted?.(rows.length);
  }, [complete, rows.length, onCounted]);
  return (
    <>
      <section className="mission-welcome" aria-label="ภาพรวม Anjuna">
        <div>
          <p className="mission-eyebrow"><span className="mission-online-dot" /> ANJUNA · MISSION CONTROL</p>
          <h1>ภาพรวมการทำงาน</h1>
          <p className="mission-welcome-desc">ดูสถานะแบรนด์ ผลลัพธ์ และเรื่องที่ต้องจัดการในที่เดียว</p>
        </div>
        <div className="mission-shortcuts">
          <a className="mission-link-secondary" href="/money" onClick={inApp("/money")}>ดูรายงาน <ArrowRight size={16} /></a>
          <a className="mission-link-primary" href="/brands/new" onClick={inApp("/brands/new")}>+ สร้างแบรนด์ใหม่</a>
        </div>
      </section>
      <div className="mission-section-label"><span>WORKSPACE OVERVIEW</span><small>ข้อมูลจริงจากระบบ · ตามขอบเขตแบรนด์ที่เลือก</small></div>
      <section className="mission-kpis" aria-label="ตัวชี้วัดภาพรวม">
        <a className="mission-kpi" href="/brands" onClick={inApp("/brands")}>
          <span className="mission-kpi-label">แบรนด์ออนไลน์ <Globe2 size={18} /></span>
          <strong>{shownNumber(activeBrands)}</strong>
          <small>จาก {shownNumber(scopedBrands?.length)} แบรนด์ในขอบเขตนี้</small>
        </a>
        {owner && <><a className="mission-kpi" href="/money" onClick={inApp("/money")}>
          <span className="mission-kpi-label">Leads วันนี้ <UsersRound size={18} /></span>
          <strong>{shownNumber(funnelSummary?.leads)}</strong>
          <small>จากรายงาน Funnel วันนี้</small>
        </a>
        <a className="mission-kpi" href="/money" onClick={inApp("/money")}>
          <span className="mission-kpi-label">ขายสำเร็จวันนี้ <TrendingUp size={18} /></span>
          <strong>{shownNumber(funnelSummary?.sold)}</strong>
          <small>ยอดขายที่ได้รับ Postback</small>
        </a></>}
        {!owner && <>
          <a className="mission-kpi" href="#mission-tasks">
            <span className="mission-kpi-label">งานรอทำ <ListTodo size={18} /></span>
            <strong>{shownNumber(rows.length)}</strong>
            <small>รายการที่อยู่ในขอบเขตนี้</small>
          </a>
          <a className="mission-kpi" href="/brands" onClick={inApp("/brands")}>
            <span className="mission-kpi-label">ฉบับร่าง <UsersRound size={18} /></span>
            <strong>{shownNumber(scopedBrands?.filter((brand) => brand.status === "draft").length)}</strong>
            <small>แบรนด์ที่ยังสร้างไม่เสร็จ</small>
          </a>
        </>}
        {owner && <>
          <a className="mission-kpi" href="/money" onClick={inApp("/money")}>
            <span className="mission-kpi-label">Revenue (USD) <CircleDollarSign size={18} /></span>
            <strong>{shownNumber(funnelSummary?.revenue, "$")}</strong>
            <small>รายได้ที่มีข้อมูลครบเท่านั้น</small>
          </a>
          <a className="mission-kpi" href="/money" onClick={inApp("/money")}>
            <span className="mission-kpi-label">Ad Spend (THB) <CreditCard size={18} /></span>
            <strong>{shownNumber(scopedSpend?.thb, "฿")}</strong>
            <small>ค่าใช้จ่ายโฆษณา · วันนี้</small>
          </a>
        </>}
      </section>
      <section className="mission-portfolio" aria-label="แบรนด์ที่ดูแล">
        <div className="mission-portfolio-head">
          <div><p className="mission-eyebrow">PORTFOLIO</p><h2>แบรนด์ที่ดูแล</h2></div>
          <a href="/brands" onClick={inApp("/brands")}>ดูทั้งหมด <ArrowRight size={16} /></a>
        </div>
        {brands === undefined && <p className="mission-muted">กำลังโหลดแบรนด์…</p>}
        {brands === null && <p className="mission-muted">ไม่สามารถโหลดข้อมูลแบรนด์ได้</p>}
        {brands && portfolio.length === 0 && <p className="mission-muted">ไม่มีแบรนด์ในขอบเขตนี้</p>}
        {portfolio.map((brand) => {
          const path = routePath({ view: "brands", brandId: brand.brand_id });
          return <a className="mission-brand-row" key={brand.brand_id} href={path} onClick={inApp(path)}>
            <span className="mission-brand-monogram" aria-hidden="true">{(brand.name || brand.hostnames[0] || "B").slice(0, 1).toUpperCase()}</span>
            <span className="mission-brand-info"><strong>{brand.hostnames[0] || brand.name || brand.brand_id}</strong><small>{brand.name || "Brand"}</small></span>
            <span className={"mission-state mission-state-" + brand.status}>{brand.status === "live" ? "ออนไลน์" : brand.status === "draft" ? "ฉบับร่าง" : brand.status === "failed" ? "ต้องแก้ไข" : brand.status === "installing" ? "กำลังติดตั้ง" : brand.status}</span>
            <ArrowRight size={16} />
          </a>;
        })}
      </section>
      <div id="mission-tasks" className="head mission-task-heading">
        <div>
          <p className="mission-eyebrow">ACTION CENTER</p>
          <h2><ListTodo size={22} aria-hidden="true" /> งานรอทำ <span className="mission-task-count">{rows.length}</span></h2>
          <p className="sub" aria-live="polite">{`มี ${rows.length} เรื่อง ด่วน ${urgent} เรื่อง เรื่องที่เสียเงินมากสุดอยู่บนสุด กดปุ่มในแถวเพื่อแก้ได้เลย`}</p>
        </div>
      </div>
      <div className="task-chips" role="group" aria-label="กรองงาน">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className="task-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {`${label} ${rows.filter((row) => matches(id, row)).length}`}
          </button>
        ))}
      </div>
      {failed.map((name) => <p key={name} className="hint">{`— โหลด${name}ไม่สำเร็จ`}</p>)}
      {loading && <p className="hint">…</p>}
      {!loading && failed.length === 0 && rows.length === 0 && <EmptyState title="ไม่มีงานค้าง ระบบทำที่เหลือให้เองแล้ว" />}
      {shown.length > 0 && (
        <ul className="task-list" aria-label="รายการงาน">
          {shown.map((row) => (
            <li key={row.id} className="task-row" data-level={row.level}>
              <Chip tone={LEVEL_TONE[row.level]}>{LEVEL_LABEL[row.level]}</Chip>
              <div className="task-main">
                <p className="task-where">{row.where}</p>
                <p className="task-title">{row.title}</p>
                <p className="task-cause">{row.cause}</p>
              </div>
              <div className="task-act">
                {row.blocked
                  ? <>
                    <button type="button" className="btn" disabled>{row.blocked.label}</button>
                    <a className="task-side" href={row.action.path} onClick={inApp(row.action.path)}>{row.action.label}</a>
                  </>
                  : <a className="btn pri" href={row.action.path} onClick={inApp(row.action.path)}>{row.action.label}</a>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {complete && <p className="hint task-foot">{`เลข ${rows.length} บนเมนู "งานรอทำ" นับจากรายการในหน้านี้ ทุกหน้าจะเห็นเลขเดียวกัน`}</p>}
    </>
  );
}
