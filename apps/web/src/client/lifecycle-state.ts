import type { InstallWithReceipts, LifecycleBrandSummary } from "@anjuna/contracts";

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
