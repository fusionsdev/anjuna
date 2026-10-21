/**
 * Panel-only audit rows in `factory.audit_log` (user management, sign-in). Brand and config
 * changes are audited by core (admin API decision 1), never here.
 */
import { AuditEntry, type AdminRole, type AuditEntry as AuditEntryT } from "@anjuna/contracts";

export const PANEL_AUDIT_PREFIXES = ["auth.", "user."] as const;
/** Factory actions that originate in the panel (brand lifecycle, install start). */
const FACTORY_AUDIT_PREFIXES = ["brand.create", "brand.duplicate", "install.start", "install.failed", "redeploy", "upgrade", "form_artifact", "checklist", "builder_key"] as const;
const isFactoryAudit = (action: string): boolean => FACTORY_AUDIT_PREFIXES.some((p) => action === p || action.startsWith(p + "."));

export const isPanelAudit = (action: string): boolean => PANEL_AUDIT_PREFIXES.some((p) => action.startsWith(p));

export interface PanelAuditInput {
  actor_id: string;
  actor_role: AdminRole;
  action: string;
  entity_type: string;
  entity_id: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export async function writeFactoryAudit(db: D1Database, a: PanelAuditInput): Promise<void> {
  if (!isFactoryAudit(a.action)) throw new Error(`Not a factory audit action: ${a.action}`);
  await db
    .prepare(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      a.actor_id,
      a.actor_role,
      a.action,
      a.entity_type,
      a.entity_id,
      a.before ? JSON.stringify(a.before) : null,
      a.after ? JSON.stringify(a.after) : null,
      new Date().toISOString(),
    )
    .run();
}

export async function writePanelAudit(db: D1Database, a: PanelAuditInput): Promise<void> {
  if (!isPanelAudit(a.action)) throw new Error(`Not a panel-only audit action: ${a.action}`);
  await db
    .prepare(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      a.actor_id,
      a.actor_role,
      a.action,
      a.entity_type,
      a.entity_id,
      a.before ? JSON.stringify(a.before) : null,
      a.after ? JSON.stringify(a.after) : null,
      new Date().toISOString(),
    )
    .run();
}

interface Row {
  id: number;
  actor_id: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

/** Panel-only rows, newest first. `actorId` restricts to one actor (employee scope). */
export async function listPanelAudit(db: D1Database, opts: { actorId?: string; limit: number }): Promise<AuditEntryT[]> {
  const where = ["(action LIKE 'auth.%' OR action LIKE 'user.%')"];
  const binds: unknown[] = [];
  if (opts.actorId) {
    binds.push(opts.actorId);
    where.push(`actor_id = ?${binds.length}`);
  }
  binds.push(opts.limit);
  const { results } = await db
    .prepare(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?${binds.length}`)
    .bind(...binds)
    .all<Row>();
  return results.map((r) =>
    AuditEntry.parse({
      id: r.id,
      actor_id: r.actor_id,
      actor_role: r.actor_role,
      action: r.action,
      target: { type: r.entity_type, id: r.entity_id },
      old: r.before_json ? JSON.parse(r.before_json) : null,
      new: r.after_json ? JSON.parse(r.after_json) : null,
      at: r.created_at,
    }),
  );
}

/** Lifecycle rows are stored beside panel audit rows, but are separately scoped so an employee
 * sees only their own lifecycle actions while an owner sees the full factory history. */
export async function listLifecycleAudit(db: D1Database, opts: { actorId?: string; limit: number }): Promise<AuditEntryT[]> {
  const where = ["action NOT LIKE 'auth.%'", "action NOT LIKE 'user.%'"];
  const binds: unknown[] = [];
  if (opts.actorId) { binds.push(opts.actorId); where.push(`actor_id = ?${binds.length}`); }
  binds.push(opts.limit);
  const { results } = await db.prepare(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?${binds.length}`).bind(...binds).all<Row>();
  return results.map((r) => AuditEntry.parse({ id: r.id, actor_id: r.actor_id, actor_role: r.actor_role, action: r.action, target: { type: r.entity_type, id: r.entity_id }, old: r.before_json ? JSON.parse(r.before_json) : null, new: r.after_json ? JSON.parse(r.after_json) : null, at: r.created_at }));
}
