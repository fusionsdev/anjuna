import type { FunnelReportResponse, LifecycleBrandSummary, PanelCampaignsResponse, PanelSpendReportResponse } from "@anjuna/contracts";
import { isDemoBrand } from "../../brand-health";
import { checklistFlags, isStale } from "../../home-metrics";
import { nextAction, type LifecycleRow, type NextAction, type Role } from "../../lifecycle-state";
import { navigate, routePath } from "../../router";
import type { ActionBrand, BrandAction } from "../../useBrandActions";
import type { BrandChecklistEntry, BrandChecklists } from "../../api";
import { SpendText, byCurrencyText, type ByCurrency } from "../BrandStatsRow";
import { adsChip, stageStatuses, stageUnknowns } from "../../brand-stages";
import type { UploadFacts } from "../../brand-facts";
import { BrandTable, type BrandTableRow } from "../../components/BrandTable";
import { num } from "./shared";

/** Home shows the five brands that need a person first; "ดูทั้งหมด n" opens the rest on Brands. */
const MAX_ROWS = 5;

/**
 * A brand that needs nothing: retired, or live with a sound runtime and no install in progress or failed.
 * Every other brand ranks first, keyed by state and never by button text, so a broken brand never drops below the row limit.
 */
function isHealthy(brand: LifecycleBrandSummary): boolean {
  if (brand.status === "retired") return true;
  const install = brand.latest_install?.status;
  return brand.status === "live" && brand.runtime_sync_status !== "failed" && brand.runtime_sync_status !== "sync_error"
    && install !== "failed" && install !== "queued" && install !== "running" && install !== "rolled_back";
}

/** A brand needs a person when its action is a step to take or its state is not healthy. Those rows rank first. */
const needsPerson = (action: NextAction, brand: LifecycleBrandSummary) => action.kind !== "open" || !isHealthy(brand);

/** The state `nextAction` reads. Checklist facts are passed only for a brand the batch lists; for any other brand they are unknown and never block. */
function rowOf(brand: LifecycleBrandSummary, entry: BrandChecklistEntry | undefined, paused: boolean): LifecycleRow {
  const flags = checklistFlags(entry);
  return {
    status: brand.status,
    runtime_sync_status: brand.runtime_sync_status,
    bundle_form_version: brand.bundle_form_version,
    payload_version: brand.payload_version,
    latest_install: brand.latest_install ?? null,
    // Core pauses a brand while its factory status still reads live, so the pause comes from the runtime list, as on the Brands screen.
    paused,
    ...(entry ? { template_approved: entry.template_approved } : {}),
    ...(flags.drain_route !== undefined ? { drain_route: flags.drain_route } : {}),
    ...(flags.test_sold !== undefined ? { test_sold: flags.test_sold } : {}),
  };
}

/**
 * Spend of one brand in each currency its accounts bill in, never added across currencies. Null when no row exists
 * (nothing was synced) or any row is older than 2 hours: a stale number is never shown as today's.
 */
function brandSpend(spend: PanelSpendReportResponse, brandId: string, now: Date): { cost: ByCurrency; estimated: boolean } | null {
  const rows = spend.brands.filter((row) => row.brand_id === brandId);
  if (rows.length === 0 || rows.some((row) => isStale(row.updated_at, now, 2))) return null;
  const cost: ByCurrency = {};
  for (const row of rows) cost[row.currency] = (cost[row.currency] ?? 0) + row.cost;
  // The mark comes from the same rows as the number: a brand with no shown cost is never marked.
  return { cost, estimated: rows.some((row) => row.allocation === "estimated") };
}

/** The leads of a live brand in the period. Null when the funnel did not load or the brand is not live, so nothing was recorded for it. */
function brandLeads(funnel: FunnelReportResponse | null | undefined, brand: LifecycleBrandSummary): number | null {
  if (!funnel || brand.status !== "live") return null;
  return funnel.rows.filter((row) => row.brand === brand.brand_id).reduce((sum, row) => sum + row.submits, 0);
}

/** The actions that change something go through the named dialog. Every other button opens the brand. */
const DIALOG_ACTION: Partial<Record<NextAction["kind"], BrandAction>> = { "test-sold": "test-sold", retry: "retry-install", "approve-template": "approve-template", "set-route": "set-route" };

/**
 * One row per brand with the numbers of the period and the one button `nextAction` picks. Spend and cost per lead are owner only
 * and come from the server's baht rows. `undefined` is loading, `null` is failed.
 */
export function BrandRows({ role, brands, checklists, paused, funnel, spend, stageFunnel, uploadFacts, adsData, spendToday, onAction }: {
  role: Role;
  brands: LifecycleBrandSummary[] | null | undefined;
  checklists: BrandChecklists | null | undefined;
  /** Ids of the brands core has paused. Null while loading or when the runtime list failed: nothing is known, so no brand reads as paused. */
  paused: ReadonlySet<string> | null | undefined;
  funnel: FunnelReportResponse | null | undefined;
  /** Owner only. `undefined` while loading, `null` when it failed or the period has no rows. */
  spend: PanelSpendReportResponse | null | undefined;
  /** The last 30 days of the funnel and of the conversion rows: they feed the lead, sold and upload stages. */
  stageFunnel?: FunnelReportResponse | null;
  /** Per brand: any uploaded or dead conversion in 30 days (brand-facts.ts). Undefined while loading. */
  uploadFacts?: Map<string, UploadFacts>;
  /** The panel campaigns, read for the Google Ads chip. Undefined loading, null failed. */
  adsData?: PanelCampaignsResponse | null;
  /** Owner only: today's spend report, which decides the Google Ads chip. Null when it is unreadable. */
  spendToday?: PanelSpendReportResponse | null;
  /** Runs a dialog action on one brand. Without it the row button opens the brand. */
  onAction?: (action: BrandAction, brand: ActionBrand) => void;
}) {
  const owner = role === "owner";
  const now = new Date();
  const rows = (brands ?? [])
    .filter((brand) => brand.status !== "retired" && !isDemoBrand(brand))
    .map((brand) => ({ brand, action: nextAction(rowOf(brand, checklists?.brands[brand.brand_id], paused?.has(brand.brand_id) === true), role) }))
    .sort((a, b) => Number(needsPerson(b.action, b.brand)) - Number(needsPerson(a.action, a.brand)));
  const click = (action: NextAction, brand: LifecycleBrandSummary) => {
    const dialog = DIALOG_ACTION[action.kind];
    if (dialog && onAction) {
      onAction(dialog, {
        id: brand.brand_id, name: brand.name ?? brand.brand_id, domain: brand.hostnames[0] ?? brand.brand_id,
        installId: brand.latest_install?.install_id ?? null, templateId: checklists?.brands[brand.brand_id]?.template_waiting_id ?? null,
      });
      return;
    }
    navigate(routePath({ view: "brands", brandId: brand.brand_id }));
  };
  const tableRows: BrandTableRow[] = rows.slice(0, MAX_ROWS).map(({ brand, action }) => {
    const leads = brandLeads(funnel, brand);
    const shown = owner && spend ? brandSpend(spend, brand.brand_id, now) : null;
    const cost = shown?.cost ?? null;
    const estimated = shown?.estimated ?? false;
    const perLead: ByCurrency | null = cost && leads ? Object.fromEntries(Object.entries(cost).map(([currency, amount]) => [currency, amount / leads])) as ByCurrency : null;
    const entry = checklists?.brands[brand.brand_id];
    const own = (rowsOf: { brand: string }[] | undefined) => rowsOf?.filter((row) => row.brand === brand.brand_id);
    const funnel30 = own(stageFunnel?.rows) as FunnelReportResponse["rows"] | undefined;
    const upload = uploadFacts?.get(brand.brand_id);
    const stageInput = {
      brand, ...(entry ? { checklist: entry } : {}),
      leads30: funnel30 ? funnel30.reduce((sum, row) => sum + row.submits, 0) : null,
      sold30: funnel30 ? funnel30.reduce((sum, row) => sum + row.sold, 0) : null,
      hasUploaded: upload ? upload.uploaded : null,
      hasDead: upload ? upload.dead : null,
    };
    const stages = stageStatuses(stageInput);
    // Cost of today for this brand: 0 when the report answered without it, null when the report is not known (employee, failed, loading).
    const todayCost = owner && spendToday ? spendToday.brands.filter((row) => row.brand_id === brand.brand_id).reduce((sum, row) => sum + row.cost, 0) : null;
    const ads = adsChip({ brand, paused: paused?.has(brand.brand_id) === true, ads: adsData, spendToday: todayCost });
    return {
      id: brand.brand_id,
      title: brand.hostnames[0] ?? brand.name ?? brand.brand_id,
      ...(brand.name && brand.name !== brand.hostnames[0] ? { subtitle: brand.name } : {}),
      demo: isDemoBrand(brand),
      stages,
      stagesUnknown: stageUnknowns(stageInput),
      ads,
      spend: spend === undefined ? "…" : <SpendText text={byCurrencyText(cost)} estimated={estimated} />,
      leads: funnel === undefined ? "…" : leads === null ? "—" : num(leads),
      costPerLead: spend === undefined ? "…" : <SpendText text={byCurrencyText(perLead)} estimated={estimated} />,
      action: { kind: action.kind, label: action.label, disabled: action.disabled, reason: action.reason, primary: needsPerson(action, brand), onClick: () => click(action, brand) },
    };
  });
  return (
    <section className="panel" aria-label="แบรนด์">
      <div className="home-ptitle">
        <h2>แบรนด์</h2>
        <a className="btn" href="/brands" onClick={(event) => { event.preventDefault(); navigate("/brands"); }}>{`ดูทั้งหมด ${rows.length}`}</a>
      </div>
      {brands === undefined && <p className="hint">…</p>}
      {brands === null && <p className="hint">— โหลดรายการแบรนด์ไม่สำเร็จ</p>}
      {brands && rows.length === 0 && <p className="hint">ยังไม่มีแบรนด์</p>}
      {tableRows.length > 0 && <BrandTable rows={tableRows} showMoney={owner} label="แบรนด์ที่ต้องดู" />}
    </section>
  );
}
