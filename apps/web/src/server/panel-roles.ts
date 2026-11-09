/**
 * Roles for panel-only actions that are not core admin endpoints (T12 plan, role matrix).
 * Core endpoints use ADMIN_ROLE_TABLE / authorize() from @anjuna/contracts.
 */
import { roleAtLeast, type AdminError, type AdminRole } from "@anjuna/contracts";

export const PANEL_ROLE_TABLE = {
  /** Plan: "Manage users" is owner only. */
  listUsers: "owner",
  createUser: "owner",
  setUserRole: "owner",
  /** Ban or unban a user (unban shares the ban gate). */
  banUser: "owner",
  /** Delete a user and their sessions. */
  deleteUser: "owner",
  /** Set a user's password (revokes their sessions too). */
  resetUserPassword: "owner",
  /** List and revoke a user's sessions. */
  manageUserSessions: "owner",
  /** Rollback and deletion are Owner-only. */
  rollbackBrand: "owner",
  /** Pause is Owner-only in the panel; core still allows employee, so this gate is the enforcement. Resume stays employee. */
  pauseBrand: "owner",
  /** Plan: "Create a brand from Domain + Keyword" is employee and owner. */
  createBrand: "employee",
  /** Plan: "Install a brand" is employee and owner. */
  installBrand: "employee",
  /**
   * Generate (wizard Review step, POST /api/brands/:id/generate): spec "Only an owner or a key with scope
   * brand:generate may run generate". The other install actions keep installBrand.
   */
  generateBrand: "owner",
  /**
   * Tracking ids on a draft (profile.ads: Google Ads account, conversion action, AdKit project, Microsoft Ads account).
   * An employee may set them before install. Raise this to "owner" and the wizard shows them read-only to an
   * employee and the draft routes refuse an employee who changes them. A live brand's money routing stays owner only.
   */
  setDraftTracking: "employee",
  /** A duplicate is a new draft, so it needs the same role as creating one. */
  duplicateBrand: "employee",
  /** Plan: "Upgrade all brands" is owner only. */
  upgradeAll: "owner",
  recoverBrand: "owner",
  /** Redeploy re-uploads the runtime of a live brand: Owner-only, like Rollback. */
  redeployBrand: "owner",
  /** Templates screen: list, detail and Import from URL are employee and owner; Approve is owner only. */
  listTemplates: "employee",
  importTemplate: "employee",
  approveTemplate: "owner",
  /** Template manager: create a category, set a template's category, archive, delete. Owner only. */
  manageTemplates: "owner",
  /** The edit page of a live brand: template version and tracking ids, read-only for an employee. */
  viewBrandEdit: "employee",
  /** Logo and favicon of a brand: like site text, an employee may upload and remove them. */
  editBrandAssets: "employee",
  /** Microsoft Ads account of a live brand (config/profile only, the drain does not read it): a money-path field, Owner only. */
  setBrandMicrosoftAds: "owner",
  /** Builder keys for the template MCP: list and create are employee and owner; revoke is owner only. */
  viewBuilderKeys: "employee",
  manageBuilderKeys: "owner",
  /** Scoped keys for /api/v1: mint, list and revoke. Owner only, because a key acts with the owner role inside its scopes. */
  manageApiKeys: "owner",
  /**
   * Wizard step 4 from the AdKit directory: project and account selects and the conversion action job. Core serves
   * the directory and queues jobs for an owner only, so an employee sees the tracking step read-only.
   */
  useAdkit: "owner",
  /** The global Microsoft Ads account in Settings (moved out of the wizard). */
  setMicrosoftAdsSetting: "owner",
  /** The Settings page: every brand's money routing and A/B config in one table, Owner only. */
  viewSettings: "owner",
  /** The per-brand timeline of changes and Ads account events: employee and owner. */
  viewBrandTimeline: "employee",
  /** Adding a manual Ads account event: employee and owner. */
  createAdsEvent: "employee",
  /** Deleting a manual Ads account event: Owner only. */
  deleteAdsEvent: "owner",
  /** T13 A3: the allocation tab (shared accounts, campaign owners, unallocated cost). Owner only; an employee never sees it. */
  adAllocation: "owner",
  /**
   * Campaigns screen (T13 Part B). The action names match CAMPAIGN_JOB_ROLES in @anjuna/contracts; core enforces the
   * same roles again. Enable is the only job that spends money.
   */
  viewCampaigns: "employee",
  createCampaignDraft: "employee",
  enableCampaign: "owner",
  pauseCampaign: "owner",
  updateCampaignBudget: "owner",
  checkCampaignStatus: "employee",
} as const satisfies Record<string, AdminRole>;
export type PanelAction = keyof typeof PANEL_ROLE_TABLE;

export function authorizePanel(
  action: PanelAction,
  role: AdminRole,
): { ok: true } | { ok: false; error: Extract<AdminError, { error: "forbidden_role" }> } {
  const min = PANEL_ROLE_TABLE[action];
  return roleAtLeast(role, min) ? { ok: true } : { ok: false, error: { error: "forbidden_role", required_role: min } };
}
