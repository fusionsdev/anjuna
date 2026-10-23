import type { BrandSummary, LifecycleBrandSummary } from "@anjuna/contracts";

/** Also the severity order, worst first. */
export type BrandIssue = "install_failed" | "sync_error" | "install_running" | "no_domain" | "paused";

const ISSUE_ORDER: readonly BrandIssue[] = ["install_failed", "sync_error", "install_running", "no_domain", "paused"];
const NO_ISSUE_SEVERITY = 99;

export type BrandChip = "all" | "live" | "paused" | "failed" | "no_domain";

export const BRAND_CHIPS: ReadonlyArray<{ id: BrandChip; label: string }> = [
  { id: "all", label: "ทั้งหมด (All)" },
  { id: "live", label: "ใช้งาน (Live)" },
  { id: "paused", label: "หยุดชั่วคราว (Paused)" },
  { id: "failed", label: "ติดตั้งล้มเหลว (Failed install)" },
  { id: "no_domain", label: "ยังไม่มีโดเมนใช้งาน (No live domain)" },
];

export type BrandSortMode = "issues" | "activity" | "az" | "profit";

export const BRAND_SORTS: ReadonlyArray<{ id: BrandSortMode; label: string; ownerOnly: boolean }> = [
  { id: "issues", label: "ปัญหาก่อน (Issues first)", ownerOnly: false },
  { id: "activity", label: "กิจกรรมล่าสุด (Latest activity)", ownerOnly: false },
  { id: "az", label: "ชื่อโดเมน A-Z (Domain A-Z)", ownerOnly: false },
  { id: "profit", label: "กำไรน้อยสุด (Worst profit)", ownerOnly: true },
];

export interface BrandHealth {
  issues: BrandIssue[];
  severity: number;
  activityAt: string | null;
}

const isFailed = (status: string | undefined) => status === "failed" || status === "rolled_back";

export function brandHealth(brand: LifecycleBrandSummary, runtime: Pick<BrandSummary, "status"> | undefined): BrandHealth {
  const latest = brand.latest_install ?? null;
  const has: Record<BrandIssue, boolean> = {
    install_failed: isFailed(brand.status) || isFailed(latest?.status),
    sync_error: brand.status === "live" && brand.runtime_sync_status === "sync_error",
    install_running: brand.status === "installing" || latest?.status === "queued" || latest?.status === "running",
    // "No live domain": no install ever reached ready, so no Custom Domain is attached.
    no_domain: brand.current_revision_id === null,
    paused: runtime?.status === "paused" || brand.status === "paused",
  };
  const issues = ISSUE_ORDER.filter((issue) => has[issue]);
  return {
    issues,
    severity: issues.length ? ISSUE_ORDER.indexOf(issues[0]!) : NO_ISSUE_SEVERITY,
    activityAt: latest?.started_at ?? null,
  };
}

export function matchesBrandChip(health: BrandHealth, brand: LifecycleBrandSummary, chip: BrandChip): boolean {
  switch (chip) {
    case "all":
      return true;
    case "live":
      return health.issues.length === 0 && brand.status === "live";
    case "paused":
      return health.issues.includes("paused");
    case "failed":
      return health.issues.includes("install_failed");
    case "no_domain":
      return health.issues.includes("no_domain");
  }
}

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
