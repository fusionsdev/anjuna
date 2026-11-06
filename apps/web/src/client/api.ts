import { TrafficBreakdownResponse, type TemplateThemeVars, type TrafficPeriod, type TrafficDimension } from "@anjuna/contracts";
import { BrandThemeVarsResponse, TemplateThemeVarsResponse } from "@anjuna/contracts";
import { BrandAssetKind, BrandAssetListResponse, BrandAssetSummary, BrandRevisionsResponse, BuilderKeyCreateResponse, DeployHistoryResponse, type DeployHistoryQuery, BuilderKeyListResponse, BuilderKeySummary, LatestUpgradeResponse, SealedTemplatesResponse, SiteTextDefaultsResponse, TemplateApproveResponse, TemplateArchiveResponse, TemplateCategoryAssignResponse, TemplateCategoryCreateResponse, TemplateDetailResponse, TemplateListResponse, TemplateSubmitResult, TrafficRiskResponse, UpdateBrandDraftResponse, type RiskPeriod } from "@anjuna/contracts";
import { AddSuppressionResponse, GetLeadResponse, LeadsResponse, RemoveSuppressionResponse, SuppressionsResponse, type LeadOutcome, type SuppressionReason, type SuppressionSource } from "@anjuna/contracts";
import { ClientErrorsResponse, TrafficReportResponse, type TrafficLogPeriod } from "@anjuna/contracts"; // spec traffic
import { ConversionSetupStateResponse } from "@anjuna/contracts";
import { BrandEditState } from "../shared/brand-edit";
import { SettingsBrandsResponse } from "../shared/settings";
import { AdsAccountEvent, TimelineResponse, type CreateAdsEventRequest } from "../shared/timeline";
import type { TimelineRequestQuery } from "./timeline";
import { DuplicateBrandResponse, WizardDefaultsResponse, WizardDraft, ZoneCheckResponse, type DuplicateBrandRequest } from "../shared/wizard";
import type {
  AdminRole,
  AlertsReportResponse,
  AuditEntry,
  BrandConfig,
  BrandPatchRequest,
  BrandProfile,
  UpdateBrandDraftRequest,
  BrandPatchResponse,
  BrandStatusChangeResponse,
  BrandSummary,
  ChecklistItemName,
  ConversionsQuery,
  ConversionsReportResponse,
  CreateBrandDraftRequest,
  InstallWithReceipts,
  LeadAggregatesResponse,
  LifecycleBrandSummary,
  UpgradeAllCommand,
  CoreListError,
  FunnelReportResponse,
  MailingStatusResponse,
  SpendPeriod,
  PanelSpendReportResponse,
  TemplateImportRequest,
  TemplateZipImportRequest,
} from "@anjuna/contracts";

export interface Me {
  id: string;
  email: string;
  role: AdminRole;
  account?: string;
}

export interface PanelUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  banned: boolean;
}

/** A better-auth session row minus the token, as GET /api/users/:id/sessions returns it (spec polish D1.1). */
export interface UserSession {
  id: string;
  created_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
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
        return "ยังไม่พร้อมใช้งาน (not implemented)";
      case "invalid_asset":
        return ({
          too_large: "ไฟล์ใหญ่เกินกำหนด (The file is too large)",
          empty: "ไฟล์ว่างเปล่า (The file is empty)",
          file_required: "ยังไม่ได้เลือกไฟล์ (No file was sent)",
          unsupported_type: "ใช้ไฟล์ PNG, SVG หรือ ICO เท่านั้น (Use a PNG, SVG or ICO file)",
          unsafe_svg: "SVG มีสคริปต์หรือลิงก์ไปไฟล์อื่น ให้ส่งออกเป็น SVG ธรรมดา (The SVG has scripts or outside references)",
          brand_clean: "ไฟล์มีชื่อแพลตฟอร์ม หรือชื่อ/โดเมนของแบรนด์อื่น ลบออกแล้วอัปโหลดใหม่ (The file names the platform or another brand)",
        } as Record<string, string>)[(this.body as { code?: string }).code ?? ""] ?? "ไฟล์ไม่ถูกต้อง (Invalid file)";
      case "template_not_sealed":
        return "เทมเพลตนี้ยังไม่ได้อนุมัติ (The template is not approved)";
      case "template_unchanged":
        return "แบรนด์ใช้เทมเพลตนี้อยู่แล้ว (The brand already runs this template)";
      case "lifecycle_operation_active":
        return "กำลังติดตั้งแบรนด์นี้อยู่ (An install is already running for this brand)";
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
    headers: body === undefined || body instanceof FormData ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data as ApiError["body"]);
  return data as T;
}

// spec leads
/** The leads filter as the screen holds it. An empty string means the filter is not set. */
export interface LeadFilterState {
  from: string;
  to: string;
  brand: string;
  status: LeadOutcome | "";
  q: string;
}

/** The suppressions filter as the screen holds it. An empty string means the filter is not set. */
export interface SuppressionFilterState {
  q: string;
  reason: SuppressionReason | "";
  source: SuppressionSource | "";
  /** A user id, or "system" for sync rows. An empty string means the filter is not set. */
  added_by: string;
}

function queryPath(path: string, entries: [string, string | null | undefined][]): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

const leadFilterEntries = (filter: LeadFilterState): [string, string][] =>
  [["from", filter.from], ["to", filter.to], ["brand", filter.brand], ["status", filter.status], ["q", filter.q]];

export const api = {
  trafficBreakdown: (period: TrafficPeriod, by: TrafficDimension) =>
    request<unknown>("GET", `/api/traffic/breakdown?${new URLSearchParams({ period, by })}`).then((body) => TrafficBreakdownResponse.parse(body)),
  builderKeys: () => request<unknown>("GET", "/api/builder-keys").then((body) => BuilderKeyListResponse.parse(body)),
  createBuilderKey: (label: string) => request<unknown>("POST", "/api/builder-keys", { label }).then((body) => BuilderKeyCreateResponse.parse(body).key),
  revokeBuilderKey: (id: string) => request<{ key: unknown }>("POST", `/api/builder-keys/${encodeURIComponent(id)}/revoke`, {}).then((body) => BuilderKeySummary.parse(body.key)),
  /** Archived templates are left out unless the Templates screen asks for them; pickers and counts never do. */
  templates: (options?: { includeArchived?: boolean }) =>
    request<unknown>("GET", options?.includeArchived ? "/api/templates?include_archived=1" : "/api/templates").then((body) => TemplateListResponse.parse(body)),
  createTemplateCategory: (name: string) => request<unknown>("POST", "/api/templates/categories", { name }).then((body) => TemplateCategoryCreateResponse.parse(body).category),
  setTemplateCategory: (templateId: string, categoryId: string | null) =>
    request<unknown>("PATCH", `/api/templates/${encodeURIComponent(templateId)}/category`, { category_id: categoryId }).then((body) => TemplateCategoryAssignResponse.parse(body)),
  archiveTemplate: (templateId: string) => request<unknown>("POST", `/api/templates/${encodeURIComponent(templateId)}/archive`, {}).then((body) => TemplateArchiveResponse.parse(body)),
  deleteTemplate: (templateId: string) => request<unknown>("DELETE", `/api/templates/${encodeURIComponent(templateId)}`).then(() => undefined),
  template: (id: string) => request<unknown>("GET", `/api/templates/${encodeURIComponent(id)}`).then((body) => TemplateDetailResponse.parse(body)),
  approveTemplate: (id: string, themeVars?: TemplateThemeVars) => request<unknown>("POST", `/api/templates/${encodeURIComponent(id)}/approve`, themeVars ? { theme_vars: themeVars } : {}).then((body) => TemplateApproveResponse.parse(body)),
  detectTemplateThemeVars: (id: string) => request<unknown>("POST", `/api/templates/${encodeURIComponent(id)}/detect-theme-vars`, {}).then((body) => TemplateThemeVarsResponse.parse(body)),
  saveTemplateThemeVars: (id: string, themeVars: TemplateThemeVars) => request<unknown>("PUT", `/api/templates/${encodeURIComponent(id)}/theme-vars`, { theme_vars: themeVars }).then((body) => TemplateThemeVarsResponse.parse(body)),
  importTemplate: (body: TemplateImportRequest) => request<unknown>("POST", "/api/templates/import", body).then((result) => TemplateSubmitResult.parse(result)),
  importTemplateZip: (fields: TemplateZipImportRequest, file: File) => {
    const body = new FormData();
    body.set("template_name", fields.template_name);
    body.set("template_id", fields.template_id);
    body.set("file", file);
    return request<unknown>("POST", "/api/templates/import-zip", body).then((result) => TemplateSubmitResult.parse(result));
  },
  sealedTemplates: () => request<unknown>("GET", "/api/templates/sealed").then((body) => SealedTemplatesResponse.parse(body)),
  me: () => request<{ user: Me }>("GET", "/api/me").then((r) => r.user),
  signIn: (email: string, password: string) => request<unknown>("POST", "/api/auth/sign-in/email", { email, password }),
  signOut: () => request<unknown>("POST", "/api/auth/sign-out", {}),
  brands: () => request<{ brands: BrandSummary[]; generated_at: string }>("GET", "/api/brands"),
  settingsBrands: () => request<unknown>("GET", "/api/settings/brands").then((body) => SettingsBrandsResponse.parse(body)), // spec settings
  brand: (id: string) => request<{ brand: BrandConfig }>("GET", `/api/brands/${encodeURIComponent(id)}`).then((r) => r.brand),
  conversionSetup: (id: string) => request<unknown>("GET", `/api/brands/${encodeURIComponent(id)}/conversion-setup`).then((body) => ConversionSetupStateResponse.parse(body).conversion_setup),
  siteTextDefaults: (brandId: string) => request<unknown>("GET", `/api/brands/${encodeURIComponent(brandId)}/site-text`).then((body) => SiteTextDefaultsResponse.parse(body)),
  brandThemeVars: (brandId: string) => request<unknown>("GET", `/api/brands/${encodeURIComponent(brandId)}/theme-vars`).then((body) => BrandThemeVarsResponse.parse(body)),
  patchBrand: (id: string, body: BrandPatchRequest) => request<BrandPatchResponse>("PATCH", `/api/brands/${encodeURIComponent(id)}`, body),
  setStatus: (id: string, action: "pause" | "resume") =>
    request<BrandStatusChangeResponse>("POST", `/api/brands/${encodeURIComponent(id)}/${action}`, {}),
  audit: (query: { cursor?: string; actor_id?: string; target_type?: string; target_id?: string } = {}) =>
    request<{ entries: AuditEntry[]; next_cursor: string | null }>("GET", queryPath("/api/audit", [["limit", "50"], ["cursor", query.cursor], ["actor_id", query.actor_id], ["target_type", query.target_type], ["target_id", query.target_id]])),
  users: () => request<{ users: PanelUser[] }>("GET", "/api/users").then((r) => r.users),
  createUser: (u: { email: string; name: string; password: string; role: AdminRole }) => request<unknown>("POST", "/api/users", u),
  setRole: (id: string, role: AdminRole) => request<unknown>("PATCH", `/api/users/${encodeURIComponent(id)}`, { role }),
  // spec polish D1.1: owner-only user admin, same paths and bodies as server/users-admin.ts.
  banUser: (id: string, reason?: string) => request<{ user: { id: string; banned: boolean } }>("POST", `/api/users/${encodeURIComponent(id)}/ban`, reason ? { reason } : {}),
  unbanUser: (id: string) => request<{ user: { id: string; banned: boolean } }>("POST", `/api/users/${encodeURIComponent(id)}/unban`, {}),
  resetUserPassword: (id: string, password: string) => request<{ user: { id: string } }>("POST", `/api/users/${encodeURIComponent(id)}/password`, { password }),
  deleteUser: (id: string) => request<{ removed: boolean }>("DELETE", `/api/users/${encodeURIComponent(id)}`),
  userSessions: (id: string) => request<{ sessions: UserSession[] }>("GET", `/api/users/${encodeURIComponent(id)}/sessions`),
  revokeUserSessions: (id: string) => request<{ revoked: boolean }>("DELETE", `/api/users/${encodeURIComponent(id)}/sessions`),
  revokeUserSession: (id: string, sessionId: string) => request<{ revoked: boolean }>("DELETE", `/api/users/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`),
  lifecycleBrands: () => request<{ brands: LifecycleBrandSummary[]; core_error?: CoreListError | null }>("GET", "/api/lifecycle/brands"),
  lifecycleBrand: (id: string) => request<{ brand: LifecycleBrandSummary }>("GET", `/api/lifecycle/brands/${encodeURIComponent(id)}`).then((r) => r.brand),
  createDraft: (body: Omit<CreateBrandDraftRequest, "brand_id" | "account" | "hostname"> & { domain: string; keyword_default: string; template_version_id: string; name?: string; profile?: BrandProfile }) =>
    request<unknown>("POST", "/api/brands/drafts", body).then((result) => WizardDraft.parse({ ...(result as object), ...(body.profile ? { profile: body.profile } : {}) })),
  updateDraft: (brandId: string, body: UpdateBrandDraftRequest) => request<unknown>("PATCH", `/api/brands/${encodeURIComponent(brandId)}/draft`, body).then((result) => UpdateBrandDraftResponse.parse(result)),
  wizardDraft: (brandId: string) => request<unknown>("GET", `/api/wizard/drafts/${encodeURIComponent(brandId)}`).then((result) => WizardDraft.parse(result)),
  wizardDefaults: () => request<unknown>("GET", "/api/wizard/defaults").then((result) => WizardDefaultsResponse.parse(result)),
  zoneCheck: (domain: string, brandId?: string) => request<unknown>("POST", "/api/wizard/zone-check", { domain, ...(brandId ? { brand_id: brandId } : {}) }).then((result) => ZoneCheckResponse.parse(result)),
  duplicateBrand: (brandId: string, body: DuplicateBrandRequest) => request<unknown>("POST", `/api/brands/${encodeURIComponent(brandId)}/duplicate`, body).then((result) => DuplicateBrandResponse.parse(result)),
  /** Checks the draft, then starts the install; a second call while it runs answers with the same install id. */
  generate: (brandId: string) => request<{ install_id: string; brand_id: string; status: string; idempotent?: boolean }>("POST", `/api/brands/${encodeURIComponent(brandId)}/generate`, {}),
  install: (brandId: string, revisionId?: string) => request<{ install_id: string; brand_id: string; status: string }>("POST", `/api/brands/${encodeURIComponent(brandId)}/install`, revisionId ? { revision_id: revisionId } : {}),
  rollbackLifecycle: (brandId: string) => request<{ install_id: string; brand_id: string; status: string }>("POST", `/api/brands/${encodeURIComponent(brandId)}/rollback`, {}),
  redeploy: (brandId: string, formArtifactId?: string, templateVersionId?: string) => request<{ install_id: string; brand_id: string; status: string }>("POST", `/api/brands/${encodeURIComponent(brandId)}/redeploy`, { ...(formArtifactId ? { form_artifact_id: formArtifactId } : {}), ...(templateVersionId ? { template_version_id: templateVersionId } : {}) }),
  brandEdit: (brandId: string) => request<unknown>("GET", `/api/brands/${encodeURIComponent(brandId)}/edit`).then((result) => BrandEditState.parse(result)),
  setMicrosoftAds: (brandId: string, account: string | null) => request<{ brand_id: string; microsoft_ads_account: string | null; changed: boolean }>("PATCH", `/api/brands/${encodeURIComponent(brandId)}/microsoft-ads`, { microsoft_ads_account: account }),
  brandAssets: (brandId: string) => request<unknown>("GET", `/api/brands/${encodeURIComponent(brandId)}/assets`).then((result) => BrandAssetListResponse.parse(result)),
  uploadBrandAsset: (brandId: string, kind: BrandAssetKind, file: File) => {
    const body = new FormData();
    body.set("file", file);
    return request<unknown>("PUT", `/api/brands/${encodeURIComponent(brandId)}/assets/${kind}`, body).then((result) => BrandAssetSummary.parse((result as { asset: unknown }).asset));
  },
  deleteBrandAsset: (brandId: string, kind: BrandAssetKind) => request<unknown>("DELETE", `/api/brands/${encodeURIComponent(brandId)}/assets/${kind}`),
  recover: (brandId: string) => request<{ install_id: string; brand_id: string; status: string }>("POST", `/api/brands/${encodeURIComponent(brandId)}/recover`, {}),
  retryInstall: (installId: string) => request<{ install_id: string; brand_id: string; status: string }>("POST", `/api/installs/${encodeURIComponent(installId)}/retry`, {}),
  installDetail: (installId: string) => request<InstallWithReceipts>("GET", `/api/installs/${encodeURIComponent(installId)}`),
  checklist: (brandId: string) => request<{ brand_id: string; checklist: Array<{ item: ChecklistItemName; evidence: unknown }> }>("GET", `/api/brands/${encodeURIComponent(brandId)}/checklist`),
  attestChecklist: (brandId: string, item: ChecklistItemName, lead_id?: string) => request<unknown>("POST", `/api/brands/${encodeURIComponent(brandId)}/checklist`, { item, ...(lead_id ? { lead_id } : {}) }),
  upgradeAll: (body: Omit<UpgradeAllCommand, "started_by" | "started_role">) => request<unknown>("POST", "/api/upgrade-all", body),
  latestUpgrade: () => request<unknown>("GET", "/api/upgrade-all/latest").then((body) => LatestUpgradeResponse.parse(body)),
  funnel: (query: { from: string; to: string; brand?: string }) => {
    const params = new URLSearchParams({ from: query.from, to: query.to });
    if (query.brand) params.set("brand", query.brand);
    return request<FunnelReportResponse>("GET", `/api/funnel?${params}`);
  },
  /** Read-only. Money and raw error text come back null for an employee. */
  conversions: (query: { period: SpendPeriod; status?: ConversionsQuery["status"]; brand?: string; limit?: number }) => {
    const params = new URLSearchParams({ period: query.period });
    if (query.status) params.set("status", query.status);
    if (query.brand) params.set("brand", query.brand);
    if (query.limit) params.set("limit", String(query.limit));
    return request<ConversionsReportResponse>("GET", `/api/conversions?${params}`);
  },
  /** Days are `YYYY-MM-DD`, UTC, inclusive. */
  leadAggregates: (query: { from: string; to: string }) =>
    request<LeadAggregatesResponse>("GET", `/api/leads/aggregates?${new URLSearchParams({ from: query.from, to: query.to })}`),
  alerts: () => request<AlertsReportResponse>("GET", "/api/alerts"),
  mailing: () => request<MailingStatusResponse>("GET", "/api/mailing"),
  /** Owner only: an employee gets 403 forbidden_role. */
  spend: (period: SpendPeriod) => request<PanelSpendReportResponse>("GET", `/api/spend?period=${encodeURIComponent(period)}`),
  trafficRisk: (period: RiskPeriod) =>
    request<unknown>("GET", `/api/traffic/risk?${new URLSearchParams({ period })}`).then((body) => TrafficRiskResponse.parse(body)),
  /** Owner only. A plain link: the browser downloads the CSV with the session cookie. */
  trafficRiskExportUrl: (period: RiskPeriod, hostname?: string) =>
    `/api/traffic/risk/export?${new URLSearchParams({ period, ...(hostname ? { hostname } : {}) })}`,
  // spec traffic
  trafficReport: (period: TrafficLogPeriod) =>
    request<unknown>("GET", `/api/traffic/report?${new URLSearchParams({ period })}`).then((body) => TrafficReportResponse.parse(body)),
  /** A plain link: the browser downloads the CSV with the session cookie. */
  trafficReportCsvUrl: (period: TrafficLogPeriod) => `/api/traffic/report.csv?${new URLSearchParams({ period })}`,
  clientErrors: (q: { period: TrafficLogPeriod; brand_id?: string; error_type?: string; cursor?: string }) =>
    request<unknown>("GET", queryPath("/api/client-errors", [["period", q.period], ["brand_id", q.brand_id], ["error_type", q.error_type], ["cursor", q.cursor]]))
      .then((body) => ClientErrorsResponse.parse(body)),
  // spec leads
  leads: (filter: LeadFilterState, cursor?: string | null) =>
    request<unknown>("GET", queryPath("/api/leads", [...leadFilterEntries(filter), ["cursor", cursor]])).then((body) => LeadsResponse.parse(body)),
  lead: (id: string) => request<unknown>("GET", `/api/leads/${encodeURIComponent(id)}`).then((body) => GetLeadResponse.parse(body).lead),
  /** A plain link: the browser downloads the CSV with the session cookie. `pii` is owner only. */
  leadsExportUrl: (filter: LeadFilterState, pii: boolean) =>
    queryPath("/api/leads/export", [...leadFilterEntries(filter), ["pii", pii ? "1" : null]]),
  /** Owner only: an employee gets 403 forbidden_role. */
  suppressions: (filter: SuppressionFilterState, cursor?: string | null) =>
    request<unknown>("GET", queryPath("/api/suppressions", [["q", filter.q], ["reason", filter.reason], ["source", filter.source], ["added_by", filter.added_by], ["cursor", cursor]]))
      .then((body) => SuppressionsResponse.parse(body)),
  // spec polish D7.1: the address travels in the body, never in a URL or log.
  addSuppression: (body: { email: string; reason?: SuppressionReason }) =>
    request<unknown>("POST", "/api/suppressions", body).then((row) => AddSuppressionResponse.parse(row)),
  removeSuppression: (email: string) =>
    request<unknown>("POST", "/api/suppressions/remove", { email }).then((row) => RemoveSuppressionResponse.parse(row)),
  // spec brands
  deploys: (query: DeployHistoryQuery = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return request<unknown>("GET", `/api/deploys${params.size ? `?${params}` : ""}`).then((body) => DeployHistoryResponse.parse(body));
  },
  brandRevisions: (brandId: string) =>
    request<unknown>("GET", `/api/brands/${encodeURIComponent(brandId)}/revisions`).then((body) => BrandRevisionsResponse.parse(body)),
  // spec timeline
  brandTimeline: (brandId: string, query: TimelineRequestQuery = {}) =>
    request<unknown>("GET", queryPath(`/api/brands/${encodeURIComponent(brandId)}/timeline`, [["from", query.from], ["to", query.to], ["types", query.types], ["limit", query.limit === undefined ? undefined : String(query.limit)]]))
      .then((body) => TimelineResponse.parse(body)),
  createAdsEvent: (brandId: string, body: CreateAdsEventRequest) =>
    request<unknown>("POST", `/api/brands/${encodeURIComponent(brandId)}/ads-events`, body).then((result) => AdsAccountEvent.parse((result as { event?: unknown } | null)?.event)),
  deleteAdsEvent: (brandId: string, eventId: string) =>
    request<unknown>("DELETE", `/api/brands/${encodeURIComponent(brandId)}/ads-events/${encodeURIComponent(eventId)}`).then((result) => AdsAccountEvent.parse((result as { deleted?: unknown } | null)?.deleted)),
};
