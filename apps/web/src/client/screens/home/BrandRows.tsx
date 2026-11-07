import type { FunnelReportResponse, LifecycleBrandSummary, PanelSpendReportResponse } from "@anjuna/contracts";
import { isDemoBrand } from "../../brand-health";
import { checklistFlags, isStale } from "../../home-metrics";
import { nextAction, type LifecycleRow, type NextAction, type Role } from "../../lifecycle-state";
import { navigate, routePath } from "../../router";
import type { BrandChecklists } from "../../api";
import { byCurrencyText, type ByCurrency } from "../BrandStatsRow";
import { num } from "./shared";

const MAX_ROWS = 10;

const STATUS_TEXT: Record<string, string> = {
  live: "ใช้งาน", draft: "ร่าง", paused: "หยุดชั่วคราว", failed: "ติดตั้งไม่สำเร็จ", rolled_back: "ย้อนกลับแล้ว",
  installing: "กำลังติดตั้ง", queued: "รอติดตั้ง", running: "กำลังติดตั้ง", unmanaged: "ไม่มีในระบบสร้าง",
};

/** Open actions rank first, the plain open button last: the brands that need a person sit on top. */
const needsPerson = (action: NextAction) => !(action.kind === "open" && action.label === "ดูแบรนด์");

/** The state `nextAction` reads. Checklist facts are passed only for a brand the batch lists; for any other brand they are unknown and never block. */
function rowOf(brand: LifecycleBrandSummary, entry: BrandChecklists["brands"][string] | undefined): LifecycleRow {
  const flags = checklistFlags(entry?.checklist);
  return {
    status: brand.status,
    runtime_sync_status: brand.runtime_sync_status,
    bundle_form_version: brand.bundle_form_version,
    payload_version: brand.payload_version,
    latest_install: brand.latest_install ?? null,
    ...(entry ? { template_approved: entry.template_approved } : {}),
    ...(flags.drain_route !== undefined ? { drain_route: flags.drain_route } : {}),
    ...(flags.test_sold !== undefined ? { test_sold: flags.test_sold } : {}),
  };
}

/**
 * Spend of one brand in each currency its accounts bill in, never added across currencies. Null when no row exists
 * (nothing was synced) or any row is older than 2 hours: a stale number is never shown as today's.
 */
function brandSpend(spend: PanelSpendReportResponse, brandId: string, now: Date): ByCurrency | null {
  const rows = spend.brands.filter((row) => row.brand_id === brandId);
  if (rows.length === 0 || rows.some((row) => isStale(row.updated_at, now, 2))) return null;
  const cost: ByCurrency = {};
  for (const row of rows) cost[row.currency] = (cost[row.currency] ?? 0) + row.cost;
  return cost;
}

/** The leads of a live brand in the period. Null when the funnel did not load or the brand is not live, so nothing was recorded for it. */
function brandLeads(funnel: FunnelReportResponse | null | undefined, brand: LifecycleBrandSummary): number | null {
  if (!funnel || brand.status !== "live") return null;
  return funnel.rows.filter((row) => row.brand === brand.brand_id).reduce((sum, row) => sum + row.submits, 0);
}

/** The button only navigates: a template goes to Templates, every other action to the brand. The dialog actions belong to Task 5. */
const open = (action: NextAction, brandId: string) => navigate(action.kind === "approve-template" ? routePath({ view: "templates", templateId: null }) : routePath({ view: "brands", brandId }));

/**
 * One row per brand with the numbers of the period and the one button `nextAction` picks. Spend and cost per lead are owner only
 * and come from the server's baht rows. `undefined` is loading, `null` is failed.
 */
export function BrandRows({ role, brands, checklists, funnel, spend }: {
  role: Role;
  brands: LifecycleBrandSummary[] | null | undefined;
  checklists: BrandChecklists | null | undefined;
  funnel: FunnelReportResponse | null | undefined;
  /** Owner only. `undefined` while loading, `null` when it failed or the period has no rows. */
  spend: PanelSpendReportResponse | null | undefined;
}) {
  const owner = role === "owner";
  const now = new Date();
  const rows = (brands ?? [])
    .filter((brand) => brand.status !== "retired" && !isDemoBrand(brand))
    .map((brand) => ({ brand, action: nextAction(rowOf(brand, checklists?.brands[brand.brand_id]), role) }))
    .sort((a, b) => Number(needsPerson(b.action)) - Number(needsPerson(a.action)));
  return (
    <section className="panel" aria-label="แบรนด์">
      <div className="home-ptitle">
        <h2>แบรนด์</h2>
        <a className="btn" href="/brands" onClick={(event) => { event.preventDefault(); navigate("/brands"); }}>ดูแบรนด์ทั้งหมด</a>
      </div>
      {brands === undefined && <p className="hint">…</p>}
      {brands === null && <p className="hint">— โหลดรายการแบรนด์ไม่สำเร็จ</p>}
      {brands && rows.length === 0 && <p className="hint">ยังไม่มีแบรนด์</p>}
      <ul className="home-brands">
        {rows.slice(0, MAX_ROWS).map(({ brand, action }) => {
          const leads = brandLeads(funnel, brand);
          const cost = owner && spend ? brandSpend(spend, brand.brand_id, now) : null;
          const perLead: ByCurrency | null = cost && leads ? Object.fromEntries(Object.entries(cost).map(([currency, amount]) => [currency, amount / leads])) as ByCurrency : null;
          return (
            <li className="home-brand" key={brand.brand_id} data-brand-id={brand.brand_id}>
              <span className="n" data-col="name"><b>{brand.hostnames[0] ?? brand.name ?? brand.brand_id}</b>{brand.name && brand.name !== brand.hostnames[0] && <small className="muted"> {brand.name}</small>}</span>
              <span data-col="state" data-label="สถานะ">{STATUS_TEXT[brand.status] ?? brand.status}</span>
              <span data-col="leads" data-label="ลีด">{funnel === undefined ? "…" : leads === null ? "—" : num(leads)}</span>
              {owner && <span data-col="spend" data-label="ค่าโฆษณา">{spend === undefined ? "…" : byCurrencyText(cost)}</span>}
              {owner && <span data-col="cpl" data-label="ต้นทุนต่อลีด">{spend === undefined ? "…" : byCurrencyText(perLead)}</span>}
              <button type="button" className={`btn${needsPerson(action) ? " pri" : ""}`} data-next-action={action.kind} disabled={action.disabled} title={action.reason} onClick={() => open(action, brand.brand_id)}>{action.label}</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
