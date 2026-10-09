import { SealedTemplatesResponse } from "@anjuna/contracts";
import type {
  AdminRole,
  AlertsReportResponse,
  AuditEntry,
  BrandConfig,
  BrandPatchRequest,
  BrandPatchResponse,
  BrandStatusChangeResponse,
  BrandSummary,
  ChecklistItemName,
  CreateBrandDraftRequest,
  InstallWithReceipts,
  LifecycleBrandSummary,
  UpgradeAllCommand,
  FunnelReportResponse,
  MailingStatusResponse,
} from "@anjuna/contracts";

export interface Me {
  id: string;
  email: string;
  role: AdminRole;
}

export interface PanelUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  banned: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string; issues?: { path: string; message: string }[]; denied_fields?: string[] } | null,
  ) {
    super(body?.error ?? `HTTP ${status}`);
  }

  /** A short Thai message for the toast. */
  get thai(): string {
    switch (this.body?.error) {
      case "unauthorized":
        return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง";
      case "forbidden_role":
        return "สิทธิ์ไม่เพียงพอ (ต้องเป็น Owner)";
      case "conflict":
        return "ข้อมูลถูกแก้ไขโดยคนอื่นแล้ว กรุณารีเฟรช";
      case "invalid":
        return `ข้อมูลไม่ถูกต้อง: ${this.body.issues?.map((i) => `${i.path} ${i.message}`).join("; ") ?? ""}`;
      case "not_implemented":
        return "ยังไม่พร้อมใช้งาน (coming with T10)";
      case "not_found":
        return "ไม่พบข้อมูล";
      default:
        return `เกิดข้อผิดพลาด (${this.status})`;
    }
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data as ApiError["body"]);
  return data as T;
}

export const api = {
  sealedTemplates: () => request<unknown>("GET", "/api/templates/sealed").then((body) => SealedTemplatesResponse.parse(body)),
  me: () => request<{ user: Me }>("GET", "/api/me").then((r) => r.user),
  signIn: (email: string, password: string) => request<unknown>("POST", "/api/auth/sign-in/email", { email, password }),
  signOut: () => request<unknown>("POST", "/api/auth/sign-out", {}),
  brands: () => request<{ brands: BrandSummary[]; generated_at: string }>("GET", "/api/brands"),
  brand: (id: string) => request<{ brand: BrandConfig }>("GET", `/api/brands/${encodeURIComponent(id)}`).then((r) => r.brand),
  patchBrand: (id: string, body: BrandPatchRequest) => request<BrandPatchResponse>("PATCH", `/api/brands/${encodeURIComponent(id)}`, body),
  setStatus: (id: string, action: "pause" | "resume") =>
    request<BrandStatusChangeResponse>("POST", `/api/brands/${encodeURIComponent(id)}/${action}`, {}),
  rollback: (id: string) => request<unknown>("POST", `/api/brands/${encodeURIComponent(id)}/rollback`, {}),
  audit: () => request<{ entries: AuditEntry[]; next_cursor: string | null }>("GET", "/api/audit?limit=100"),
  users: () => request<{ users: PanelUser[] }>("GET", "/api/users").then((r) => r.users),
  createUser: (u: { email: string; name: string; password: string; role: AdminRole }) => request<unknown>("POST", "/api/users", u),
  setRole: (id: string, role: AdminRole) => request<unknown>("PATCH", `/api/users/${encodeURIComponent(id)}`, { role }),
  lifecycleBrands: () => request<{ brands: LifecycleBrandSummary[] }>("GET", "/api/lifecycle/brands"),
  lifecycleBrand: (id: string) => request<{ brand: LifecycleBrandSummary }>("GET", `/api/lifecycle/brands/${encodeURIComponent(id)}`).then((r) => r.brand),
  createDraft: (body: Omit<CreateBrandDraftRequest, "brand_id" | "account" | "hostname"> & { domain: string; keyword_default: string; template_version_id: string }) =>
    request<{ brand: { brand_id: string }; revision: { revision_id: string } }>("POST", "/api/brands/drafts", body),
  install: (brandId: string, revisionId?: string) => request<{ install_id: string; brand_id: string; status: string }>("POST", `/api/brands/${encodeURIComponent(brandId)}/install`, revisionId ? { revision_id: revisionId } : {}),
  rollbackLifecycle: (brandId: string) => request<{ install_id: string; brand_id: string; status: string }>("POST", `/api/brands/${encodeURIComponent(brandId)}/rollback`, {}),
  recover: (brandId: string) => request<{ install_id: string; brand_id: string; status: string }>("POST", `/api/brands/${encodeURIComponent(brandId)}/recover`, {}),
  retryInstall: (installId: string) => request<{ install_id: string; brand_id: string; status: string }>("POST", `/api/installs/${encodeURIComponent(installId)}/retry`, {}),
  installDetail: (installId: string) => request<InstallWithReceipts>("GET", `/api/installs/${encodeURIComponent(installId)}`),
  checklist: (brandId: string) => request<{ brand_id: string; checklist: Array<{ item: ChecklistItemName; evidence: unknown }> }>("GET", `/api/brands/${encodeURIComponent(brandId)}/checklist`),
  attestChecklist: (brandId: string, item: ChecklistItemName, lead_id?: string) => request<unknown>("POST", `/api/brands/${encodeURIComponent(brandId)}/checklist`, { item, ...(lead_id ? { lead_id } : {}) }),
  upgradeAll: (body: Omit<UpgradeAllCommand, "started_by" | "started_role">) => request<unknown>("POST", "/api/upgrade-all", body),
  funnel: (query: { from: string; to: string; brand?: string }) => {
    const params = new URLSearchParams({ from: query.from, to: query.to });
    if (query.brand) params.set("brand", query.brand);
    return request<FunnelReportResponse>("GET", `/api/funnel?${params}`);
  },
  alerts: () => request<AlertsReportResponse>("GET", "/api/alerts"),
  mailing: () => request<MailingStatusResponse>("GET", "/api/mailing"),
};
