import type { AdminRole, InstallStatus, InstallWithReceipts, LifecycleBrandSummary } from "@anjuna/contracts";

export type LifecycleUiStatus = "draft" | "queued" | "running" | "ready" | "failed" | "rolled_back" | "detached" | "unmanaged" | "sync_error";
export type LifecycleBrandForUi = Omit<LifecycleBrandSummary, "runtime_sync_status" | "status"> & { status: LifecycleBrandSummary["status"] | LifecycleUiStatus; runtime_sync_status: "queued" | "running" | "ready" | "failed" | "sync_error" };
export type LifecycleEvent =
  | { type: "brand"; brand: LifecycleBrandForUi }
  | { type: "brand_refresh"; brand: LifecycleBrandForUi }
  | { type: "install"; install: InstallWithReceipts }
  | { type: "retry"; install_id: string; compensation_install_id?: string }
  | { type: "compensation"; install_id: string }
  | { type: "status"; status: LifecycleUiStatus };

export interface LifecycleState {
  lifecycle_status: LifecycleUiStatus;
  runtime_sync_status: "queued" | "running" | "ready" | "failed" | "sync_error";
  brand?: LifecycleBrandForUi;
  install?: InstallWithReceipts;
  retry_install_id?: string;
  compensation_install_id?: string;
  operation_status?: "retry" | "compensation";
}

export function reduceLifecycleState(state: LifecycleState | undefined, event: LifecycleEvent): LifecycleState {
  const current: LifecycleState = state ?? { lifecycle_status: "draft", runtime_sync_status: "queued" };
  if (event.type === "brand") {
    const status = event.brand.status === "live" ? "ready" : event.brand.status === "failed" ? "failed" : event.brand.status === "rolled_back" ? "rolled_back" : event.brand.status === "draft" ? "draft" : "running";
    return { ...current, brand: event.brand, lifecycle_status: status, runtime_sync_status: event.brand.runtime_sync_status === "ready" ? "ready" : event.brand.runtime_sync_status };
  }
  // The server brand summary is the authority that clears a sticky sync_error; install events cannot.
  // While an install is queued or running, the install detail owns the runtime status, so only the brand is replaced.
  if (event.type === "brand_refresh") {
    const installing = current.install?.status === "queued" || current.install?.status === "running";
    return installing ? { ...current, brand: event.brand } : { ...current, brand: event.brand, runtime_sync_status: event.brand.runtime_sync_status };
  }
  if (event.type === "install") {
    const status = event.install.status === "ready" && event.install.revision_id === null ? "detached" : event.install.status;
    return { ...current, install: event.install, lifecycle_status: status, runtime_sync_status: current.runtime_sync_status === "sync_error" ? "sync_error" : event.install.runtime_sync_status };
  }
  if (event.type === "retry") return { ...current, retry_install_id: event.install_id, compensation_install_id: event.compensation_install_id, operation_status: "retry" };
  if (event.type === "compensation") return { ...current, compensation_install_id: event.install_id, operation_status: "compensation" };
  return { ...current, lifecycle_status: event.status };
}

export function shouldPollLifecycle(state: LifecycleState | undefined): boolean {
  const status = state?.install?.status;
  return status === "queued" || status === "running";
}

export function shouldRecoverAcceptedInstall(
  pendingBrandId: string | undefined,
  pendingInstallId: string | undefined,
  selectedBrandId: string | null,
  install: InstallWithReceipts | undefined,
  state: LifecycleState | undefined,
): boolean {
  if (!pendingBrandId || !pendingInstallId || !selectedBrandId || pendingBrandId !== selectedBrandId) return false;
  if (install && install.brand_id !== selectedBrandId) return false;
  return !install || install.install_id !== pendingInstallId || shouldPollLifecycle(state);
}

/**
 * Async lifecycle results may arrive after the operator selected another
 * brand.  Keep this predicate pure so the UI can enforce that boundary and
 * tests can prove stale results are rejected without a browser.
 */
export function isCurrentOperationResult(
  selectedId: string | null,
  generation: number,
  currentSelectedId: string | null,
  currentGeneration: number,
  resultBrandId: string,
): boolean {
  return selectedId !== null
    && selectedId === currentSelectedId
    && generation === currentGeneration
    && resultBrandId === currentSelectedId;
}

export function isCurrentRefresh(
  selectedId: string | null,
  generation: number,
  currentSelectedId: string | null,
  currentGeneration: number,
): boolean {
  return selectedId === currentSelectedId && generation === currentGeneration;
}

/**
 * The server's recovery_required evidence splits Retry from Recover.  A failed
 * install with a retained lock but no evidence keeps Retry, which the API
 * redirects to Recover when the evidence appears.
 */
export function lifecycleMutationAvailability(
  brandStatus: string,
  installStatus?: InstallWithReceipts["status"],
  pendingOperation = false,
  recoveryRequired = false,
): { install: boolean; rollback: boolean; retry: boolean; recover: boolean } {
  if (pendingOperation || installStatus === "queued" || installStatus === "running") {
    return { install: false, rollback: false, retry: false, recover: false };
  }
  return {
    install: brandStatus === "draft" || brandStatus === "failed",
    rollback: brandStatus === "live" || brandStatus === "failed",
    retry: installStatus === "failed" && !recoveryRequired,
    recover: installStatus === "failed" && recoveryRequired,
  };
}

export type Role = AdminRole;
export type LifecycleRowStatus = LifecycleBrandForUi["status"];

/**
 * What nextAction reads from one brand row. A LifecycleBrandSummary fits as is.
 * paused: core paused the brand (the factory status of a paused brand still reads live).
 * template_approved, drain_route, test_sold: false means that step is open, undefined means the caller does not know, and unknown never blocks.
 * recovery_required: the failed install holds evidence only Recover can clear. Only the selected brand's install detail knows it.
 */
export interface LifecycleRow {
  status: LifecycleRowStatus;
  runtime_sync_status: LifecycleBrandForUi["runtime_sync_status"];
  bundle_form_version: string | null;
  payload_version: string | null;
  latest_install?: { status: InstallStatus } | null;
  paused?: boolean;
  recovery_required?: boolean;
  template_approved?: boolean;
  drain_route?: boolean;
  test_sold?: boolean;
}

export type NextActionKind = "install" | "retry" | "approve-template" | "set-route" | "test-sold" | "open" | "resume";
/** disabled is set with a Thai reason when this role (or the row) cannot run the action. The action stays in view. */
export type NextAction = { kind: NextActionKind; label: string; disabled: boolean; reason?: string };

const enabled = (kind: NextActionKind, label: string): NextAction => ({ kind, label, disabled: false });
const refused = (kind: NextActionKind, label: string, reason: string): NextAction => ({ kind, label, disabled: true, reason });
/** An action only the owner may run: the employee sees it disabled with the reason. */
const ownerOnly = (role: Role, kind: NextActionKind, label: string, reason: string): NextAction => (role === "owner" ? enabled(kind, label) : refused(kind, label, reason));

/**
 * The one button a brand row offers, first match wins:
 * retired, then an install in progress (progress), a failed install (retry, or Recover when it needs recovery),
 * a pause (resume), a template waiting for approval, a draft or failed brand (install), a brand that needs a look
 * (rolled back, detached, or a live brand with a runtime sync problem), then an open drain route, an open test sold,
 * and last the plain open.
 * Pure: the role only decides whether an action is disabled, never which one is chosen.
 */
export function nextAction(row: LifecycleRow, role: Role): NextAction {
  const installStatus = row.latest_install?.status;
  if (row.status === "retired") return enabled("open", "ดูแบรนด์");
  if (row.status === "installing" || row.status === "queued" || row.status === "running" || installStatus === "queued" || installStatus === "running") return enabled("open", "ดูความคืบหน้า");
  if (installStatus === "failed") {
    return row.recovery_required ? ownerOnly(role, "retry", "กู้คืน", "เฉพาะเจ้าของกู้คืนได้") : enabled("retry", "ลองใหม่");
  }
  if (row.paused || row.status === "paused") return enabled("resume", "เปิดใช้งานต่อ");
  if (row.template_approved === false) return ownerOnly(role, "approve-template", "อนุมัติเทมเพลต", "เฉพาะเจ้าของอนุมัติเทมเพลตได้");
  if (row.status === "draft" || row.status === "failed") {
    return row.bundle_form_version == null || row.payload_version == null ? refused("install", "ติดตั้ง", "ยังไม่มีฟอร์มที่ยืนยันแล้ว") : enabled("install", "ติดตั้ง");
  }
  if (row.status === "rolled_back" || row.status === "detached" || row.status === "sync_error") return enabled("open", "ตรวจสอบ");
  if (row.status === "live" || row.status === "ready") {
    // Like brandHealth, only a live brand's runtime sync counts: a core-only row reads sync_error whenever core state is missing.
    if (row.runtime_sync_status === "sync_error" || row.runtime_sync_status === "failed") return enabled("open", "ตรวจสอบ");
    if (row.drain_route === false) return ownerOnly(role, "set-route", "ตั้งเส้นทาง", "เฉพาะเจ้าของตั้งเส้นทางได้");
    if (row.test_sold === false) return enabled("test-sold", "ยืนยันขายทดสอบ");
  }
  return enabled("open", "ดูแบรนด์");
}
