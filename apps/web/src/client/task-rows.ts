import type { AlertsReportResponse, ConversionsReportResponse, LifecycleBrandSummary, TemplateVersionSummary } from "@anjuna/contracts";
import { alertFix, alertPath } from "./alert-fix";
import { RULE_TITLE, incidentsOf, isOpenIncident, type Incident } from "./alert-incidents";
import { DEAD_SHORT, deadClass, type DeadClass } from "./conversion-labels";
import { clickLossWarning } from "./home-metrics";
import { awaitingApproval, isDraft, needsDrainRoute, needsTestSold, type ChecklistEntry } from "./task-counts";

/**
 * The rows of งานรอทำ (`/`). Pure and React-free, so GET /api/nav/counts builds the same rows and the sidebar badge is
 * their count. A source passed as null adds no rows; the screen says on its own line which source failed.
 */

/** ด่วน, รอทำ, ระบบ. The list sorts in this order. */
export type TaskLevel = "urgent" | "todo" | "system";
/** The filter chips other than ทั้งหมด and ด่วน. */
export type TaskCategory = "brand" | "template" | "system";

/** One row: a level tag, where, a title, a one-line cause and one button. A blocked row shows its button disabled and a side link. */
export interface TaskRow {
  id: string;
  level: TaskLevel;
  category: TaskCategory;
  where: string;
  title: string;
  cause: string;
  action: { label: string; path: string };
  blocked?: { label: string };
}

/** The template fields a row needs. The server reads no similarity count, which only changes the button, never the count. */
export type TaskTemplate = Pick<TemplateVersionSummary, "template_version_id" | "name" | "version" | "status" | "archived"> & { similarity_fail_count?: number };

export interface TaskInputs {
  /** Drain route and template approval are the owner's work; an employee gets neither row. */
  owner: boolean;
  /** The alerts report already cut to the brand scope, the stored ack/close states, and the hostname to brand lookup. */
  alerts: { report: AlertsReportResponse; states: ReadonlyMap<string, { closed_at: string | null }>; brandOfHostname: (hostname: string) => string | null } | null;
  /** The brands the /brands list shows under the scope (listedInBrands). */
  brands: readonly LifecycleBrandSummary[] | null;
  /** The batch checklist read, keyed by brand id. */
  checklists: Readonly<Record<string, ChecklistEntry>> | null;
  templates: readonly TaskTemplate[] | null;
  /** The dead conversions of DEAD_PERIOD, every brand. */
  dead: Pick<ConversionsReportResponse, "totals" | "rows"> | null;
  /** Owner only: today's paid clicks and the visitors who reached the site, from clickTotals. Null for an employee or a failed read. */
  clicks: { paid: number; reached: number } | null;
  /** brand_id to domain. An id with no domain reads as itself. */
  domains: ReadonlyMap<string, string>;
}

/** The window of the dead conversions row: the widest period core reports. */
export const DEAD_PERIOD = "30d" as const;

/** The window of the click loss row: today, the UTC day the spend report's `today` covers. */
export const CLICK_PERIOD = "today" as const;

/** The funnel range of CLICK_PERIOD: the UTC day of `now`, `to` exclusive, like the money screen's today. */
export function clickRange(now: Date): { from: string; to: string } {
  const day = now.toISOString().slice(0, 10);
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { from: `${day}T00:00:00.000Z`, to: next.toISOString() };
}

/**
 * Paid clicks (the spend report) and visitors who reached the site (the funnel clicks), each summed over the brands in scope.
 * The page and GET /api/nav/counts both call this, so the click loss row comes from the same numbers on both.
 */
export function clickTotals(
  spend: { brands: ReadonlyArray<{ brand_id: string; clicks: number }> },
  funnel: { rows: ReadonlyArray<{ brand: string; clicks: number }> },
  inScope: (brandId: string) => boolean,
): { paid: number; reached: number } {
  const paid = spend.brands.reduce((sum, row) => (inScope(row.brand_id) ? sum + row.clicks : sum), 0);
  const reached = funnel.rows.reduce((sum, row) => (inScope(row.brand) ? sum + row.clicks : sum), 0);
  return { paid, reached };
}

// The pages the buttons open. Literal paths, since router.ts imports React and the Worker imports this file.
export const TASK_PATHS = {
  drainRoute: "/brands?chip=drain-route",
  testSold: "/brands?chip=test-sold",
  drafts: "/brands?chip=drafts",
  templates: "/templates?status=awaiting_approval",
  dead: `/conversions?period=${DEAD_PERIOD}&status=dead`,
  traffic: "/traffic",
} as const;

/** One template version in the Templates drawer, the path routePath builds. */
const templatePath = (id: string): string => `/templates/${encodeURIComponent(id)}`;

const LEVEL_ORDER: Record<TaskLevel, number> = { urgent: 0, todo: 1, system: 2 };

const domainOf = (domains: ReadonlyMap<string, string>, brand: LifecycleBrandSummary): string => domains.get(brand.brand_id) ?? brand.hostnames[0] ?? brand.name ?? brand.brand_id;

/** "a.com" for one brand, "a.com และอีก 11 แบรนด์" for more. */
const groupedWhere = (names: string[]): string => (names.length === 1 ? names[0]! : `${names[0]} และอีก ${names.length - 1} แบรนด์`);

function alertRows(input: NonNullable<TaskInputs["alerts"]>, domains: ReadonlyMap<string, string>): TaskRow[] {
  const { report, states, brandOfHostname } = input;
  // Open alert-level rows first, like the Alerts screen.
  const open = incidentsOf(report, brandOfHostname).filter((incident) => isOpenIncident(incident, states));
  return open.map((incident: Incident): TaskRow => {
    const fix = alertFix(incident, report);
    const hostname = incident.rule === "click_risk" ? incident.id.slice("click_risk:".length) : null;
    const where = incident.brand ? domains.get(incident.brand) ?? incident.brand : hostname || "ทุกแบรนด์";
    return {
      id: `alert:${incident.id}`,
      level: "urgent",
      // A row that names a brand or a site is brand work; the stalled queue and unshared ad spend are system-wide.
      category: incident.brand || hostname ? "brand" : "system",
      where,
      title: incident.rule === "reject_rate" ? rejectTitle(report, incident.brand) : RULE_TITLE[incident.rule],
      cause: fix?.cause ?? incident.detail,
      action: fix ? { label: fix.label, path: fix.path } : { label: "ดูรายละเอียด", path: alertPath(incident.key ?? incident.id) },
    };
  });
}

/** "ลีดโดนปฏิเสธ 38%" for a brand the reject rule lists, the rule title otherwise. */
function rejectTitle(report: AlertsReportResponse, brand: string | null): string {
  const row = brand ? report.reject_rate.detail.brands.find((b) => b.brand === brand) : undefined;
  return row ? `ลีดโดนปฏิเสธ ${Math.round(row.rate * 100)}%` : RULE_TITLE.reject_rate;
}

function deadRow(dead: NonNullable<TaskInputs["dead"]>): TaskRow | null {
  const total = dead.totals.dead;
  if (total <= 0) return null;
  // Codes with their own reason text count as อื่นๆ.
  const counts = new Map<DeadClass, number>();
  for (const row of dead.rows) {
    if (row.status !== "dead") continue;
    const kind = deadClass(row) ?? "unknown";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const read = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const order: DeadClass[] = ["one_per_click", "adkit_failed", "no_click_id", "unknown"];
  const present = order.filter((kind) => (counts.get(kind) ?? 0) > 0);
  // Core sends no count per class. Past the read limit the unread rows have no class, so the line names the classes read without counts.
  const cause = read >= total
    ? present.map((kind) => `${DEAD_SHORT[kind]} ${counts.get(kind)}`).join(" · ")
    : present.map((kind) => DEAD_SHORT[kind]).join(" · ");
  return {
    id: "conversions:dead",
    level: "system",
    category: "system",
    where: "ส่งยอดขายให้ Google Ads",
    title: `ส่งยอดขายไม่สำเร็จ ${total} รายการ`,
    cause,
    action: { label: `ดูทั้ง ${total} รายการ`, path: TASK_PATHS.dead },
  };
}

/** Every row, most urgent first: open alerts, missing sale routes and lost paid clicks, then the to-dos, then the system rows. */
export function taskRows(input: TaskInputs): TaskRow[] {
  const rows: TaskRow[] = [];
  const { brands, checklists, domains } = input;
  if (input.alerts) rows.push(...alertRows(input.alerts, domains));
  if (brands && checklists) {
    const pick = (test: (brand: LifecycleBrandSummary, entry: ChecklistEntry) => boolean) => brands.filter((brand) => test(brand, checklists[brand.brand_id]));
    const drain = input.owner ? pick(needsDrainRoute) : [];
    if (drain.length > 0) rows.push({
      id: "brands:drain-route", level: "urgent", category: "brand",
      where: groupedWhere(drain.map((brand) => domainOf(domains, brand))),
      title: "Google Ads ยังไม่รู้ว่าขายได้",
      cause: "ยังไม่ได้ตั้งเส้นทางส่งยอดขาย ทำให้ Google ไม่รู้ว่าโฆษณาตัวไหนทำเงิน",
      action: { label: `ตั้งค่า ${drain.length} แบรนด์`, path: TASK_PATHS.drainRoute },
    });
    const testSold = pick(needsTestSold);
    if (testSold.length > 0) rows.push({
      id: "brands:test-sold", level: "todo", category: "brand",
      where: `${testSold.length} แบรนด์`,
      title: "ยังไม่ได้ทดสอบการขาย",
      cause: "ลองขาย 1 ครั้งต่อแบรนด์ เพื่อเช็กว่ายอดขายส่งถึง Google Ads จริง",
      action: { label: `ดู ${testSold.length} แบรนด์`, path: TASK_PATHS.testSold },
    });
  }
  if (input.owner && input.clicks && clickLossWarning(input.clicks.paid, input.clicks.reached)) rows.push({
    id: "click-loss", level: "urgent", category: "system",
    where: "Google Ads",
    title: `Google คิดเงิน ${input.clicks.paid} คลิก มาถึงเว็บ ${input.clicks.reached} คน`,
    cause: "คลิกที่จ่ายเงินหายก่อนถึงเว็บ ตรวจลิงก์ปลายทางและ gclid",
    action: { label: "ตรวจทราฟฟิก", path: TASK_PATHS.traffic },
  });
  if (input.owner && input.templates) {
    for (const template of input.templates.filter(awaitingApproval)) {
      const fails = template.similarity_fail_count ?? 0;
      rows.push({
        id: `template:${template.template_version_id}`, level: "todo", category: "template",
        where: `เทมเพลต ${template.name} v${template.version}`,
        ...(fails > 0
          ? {
            title: "รออนุมัติ แต่หน้าตาซ้ำกับแบรนด์อื่น",
            cause: `เช็กความซ้ำไม่ผ่าน ${fails} ข้อ ต้องแก้ให้ผ่านก่อนถึงจะอนุมัติได้`,
            action: { label: "ดูข้อที่ไม่ผ่าน", path: templatePath(template.template_version_id) },
            blocked: { label: "ยังอนุมัติไม่ได้" },
          }
          : { title: "รออนุมัติ", cause: "เช็กความซ้ำผ่านแล้ว รอกดอนุมัติ", action: { label: "ไปอนุมัติ", path: TASK_PATHS.templates } }),
      });
    }
  }
  if (brands) {
    const drafts = brands.filter(isDraft);
    if (drafts.length > 0) {
      const names = drafts.map((brand) => brand.name ?? brand.brand_id);
      rows.push({
        id: "brands:drafts", level: "todo", category: "brand",
        where: `แบรนด์ที่สร้างค้างไว้ ${drafts.length} แบรนด์`,
        title: "สร้างแบรนด์ยังไม่เสร็จ",
        cause: names.length > 3 ? `${names.slice(0, 3).join(", ")} และอีก ${names.length - 3} แบรนด์` : names.join(", "),
        action: { label: "สร้างต่อ", path: TASK_PATHS.drafts },
      });
    }
  }
  const dead = input.dead ? deadRow(input.dead) : null;
  if (dead) rows.push(dead);
  // A stable sort keeps the source order inside a level.
  return rows.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
