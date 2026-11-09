import type { BrandSummary, LifecycleBrandSummary } from "@anjuna/contracts";

/** Also the severity order, worst first. */
export type BrandIssue = "install_failed" | "sync_error" | "install_running" | "no_domain" | "paused" | "checklist_failing";

const ISSUE_ORDER: readonly BrandIssue[] = ["install_failed", "sync_error", "install_running", "no_domain", "paused", "checklist_failing"];
const NO_ISSUE_SEVERITY = 99;

export type BrandChip = "all" | "needs-fix" | "live" | "unfinished" | "paused";

export const BRAND_CHIPS: ReadonlyArray<{ id: BrandChip; label: string }> = [
  { id: "needs-fix", label: "ต้องแก้" },
  { id: "all", label: "ทั้งหมด" },
  { id: "live", label: "ใช้งาน" },
  { id: "unfinished", label: "ยังไม่เสร็จ" },
  { id: "paused", label: "หยุด" },
];

export type BrandSortMode = "issues" | "activity" | "az" | "profit";

export const BRAND_SORTS: ReadonlyArray<{ id: BrandSortMode; label: string; ownerOnly: boolean }> = [
  { id: "issues", label: "ปัญหาก่อน", ownerOnly: false },
  { id: "activity", label: "กิจกรรมล่าสุด", ownerOnly: false },
  { id: "az", label: "ชื่อโดเมน A-Z", ownerOnly: false },
  { id: "profit", label: "กำไรน้อยสุด", ownerOnly: true },
];

export interface BrandHealth {
  issues: BrandIssue[];
  severity: number;
  activityAt: string | null;
}

const isFailed = (status: string | undefined) => status === "failed" || status === "rolled_back";

/**
 * coreListFailed: the brands list carries core_error.
 * checklistFailing: any checklist row of the brand has no evidence. The caller that reads the checklists passes it; absent means unknown and never raises the issue.
 */
export function brandHealth(brand: LifecycleBrandSummary, runtime: Pick<BrandSummary, "status"> | undefined, options?: { coreListFailed?: boolean; checklistFailing?: boolean }): BrandHealth {
  const latest = brand.latest_install ?? null;
  const has: Record<BrandIssue, boolean> = {
    install_failed: isFailed(brand.status) || isFailed(latest?.status),
    // Without core state every factory brand reads sync_error; core_error already reports that outage once.
    sync_error: !options?.coreListFailed && brand.status === "live" && brand.runtime_sync_status === "sync_error",
    install_running: brand.status === "installing" || latest?.status === "queued" || latest?.status === "running",
    // "No live domain": no install ever reached ready, so no Custom Domain is attached.
    // A core-only row has no factory revision either, but core is serving its domain.
    no_domain: brand.status !== "unmanaged" && brand.current_revision_id === null,
    paused: runtime?.status === "paused" || brand.status === "paused",
    checklist_failing: options?.checklistFailing === true,
  };
  const issues = ISSUE_ORDER.filter((issue) => has[issue]);
  return {
    issues,
    severity: issues.length ? ISSUE_ORDER.indexOf(issues[0]!) : NO_ISSUE_SEVERITY,
    activityAt: latest?.started_at ?? null,
  };
}

/**
 * needs-fix: a failed install, a sync error, no live domain or a failing checklist. unfinished: still a draft or an install is running.
 * live ignores a failing checklist, so a live brand with open checklist rows stays under live.
 */
export function matchesBrandChip(health: BrandHealth, brand: LifecycleBrandSummary, chip: BrandChip): boolean {
  switch (chip) {
    case "all":
      return true;
    case "needs-fix":
      return NEEDS_FIX_ISSUES.some((issue) => health.issues.includes(issue));
    case "live":
      return brand.status === "live" && health.issues.every((issue) => issue === "checklist_failing");
    case "unfinished":
      return brand.status === "draft" || health.issues.includes("install_running");
    case "paused":
      return health.issues.includes("paused");
  }
}

const NEEDS_FIX_ISSUES: readonly BrandIssue[] = ["install_failed", "sync_error", "no_domain", "checklist_failing"];

/** A demo brand is named demo followed by digits. The Brands list hides it until the operator asks for it. */
export const isDemoBrand = (brand: Pick<LifecycleBrandSummary, "name">): boolean => /^demo\d+/.test(brand.name ?? "");

export function matchesBrandSearch(brand: LifecycleBrandSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [...brand.hostnames, brand.name ?? "", brand.brand_id].some((value) => value.toLowerCase().includes(needle));
}

type SortRead = { health: BrandHealth; domain: string; profit: number | null };

/** Newest first, a missing time last. */
function byActivity(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? 1 : -1;
}

const byDomain = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function sortBrands<T>(rows: T[], mode: BrandSortMode, read: (row: T) => SortRead): T[] {
  if (mode === "profit") return sortWorstProfitFirst(rows, (row) => read(row).profit);
  return [...rows].sort((a, b) => {
    const left = read(a);
    const right = read(b);
    if (mode === "az") return byDomain(left.domain, right.domain);
    if (mode === "issues" && left.health.severity !== right.health.severity) return left.health.severity - right.health.severity;
    return byActivity(left.health.activityAt, right.health.activityAt) || byDomain(left.domain, right.domain);
  });
}

/** Worst profit first. A brand whose profit is unknown goes last, in its original order. */
export function sortWorstProfitFirst<T>(items: T[], profit: (item: T) => number | null): T[] {
  return [...items].sort((a, b) => {
    const left = profit(a);
    const right = profit(b);
    return left === null ? (right === null ? 0 : 1) : right === null ? -1 : left - right;
  });
}
