import type { InstallWithReceipts, LifecycleBrandSummary } from "@anjuna/contracts";

export type LifecycleUiStatus = "draft" | "queued" | "running" | "ready" | "failed" | "rolled_back" | "detached" | "unmanaged" | "sync_error";
export type LifecycleBrandForUi = Omit<LifecycleBrandSummary, "runtime_sync_status" | "status"> & { status: LifecycleBrandSummary["status"] | LifecycleUiStatus; runtime_sync_status: "queued" | "running" | "ready" | "failed" | "sync_error" };
export type LifecycleEvent =
  | { type: "brand"; brand: LifecycleBrandForUi }
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
