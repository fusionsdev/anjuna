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
  /** Rollback and deletion are Owner-only. */
  rollbackBrand: "owner",
  /** Pause is Owner-only in the panel; core still allows employee, so this gate is the enforcement. Resume stays employee. */
  pauseBrand: "owner",
  deleteBrand: "owner",
  /** Plan: "Create a brand from Domain + Keyword" is employee and owner. */
  createBrand: "employee",
  /** Plan: "Install a brand" is employee and owner. */
  installBrand: "employee",
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
  /** Builder keys for the template MCP: list and create are employee and owner; revoke is owner only. */
  viewBuilderKeys: "employee",
  manageBuilderKeys: "owner",
} as const satisfies Record<string, AdminRole>;
export type PanelAction = keyof typeof PANEL_ROLE_TABLE;

export function authorizePanel(
  action: PanelAction,
  role: AdminRole,
): { ok: true } | { ok: false; error: Extract<AdminError, { error: "forbidden_role" }> } {
  const min = PANEL_ROLE_TABLE[action];
  return roleAtLeast(role, min) ? { ok: true } : { ok: false, error: { error: "forbidden_role", required_role: min } };
}
