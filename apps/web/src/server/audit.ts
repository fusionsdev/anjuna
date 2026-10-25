/**
 * Panel-only audit rows in `factory.audit_log` (user management, sign-in). Brand and config
 * changes are audited by core (admin API decision 1), never here.
 */
import { AuditEntry, type AdminRole, type AuditEntry as AuditEntryT } from "@anjuna/contracts";

export const PANEL_AUDIT_PREFIXES = ["auth.", "user."] as const;
/** Factory actions that originate in the panel (brand lifecycle, install start). */
const FACTORY_AUDIT_PREFIXES = ["brand.create", "brand.duplicate", "brand.asset", "brand.profile", "install.start", "install.failed", "redeploy", "upgrade", "form_artifact", "checklist", "builder_key", "ads_event"] as const;
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

/** The audit insert, unexecuted, so a route can run it in the same `db.batch` as its data change. */
export function factoryAuditStatement(db: D1Database, a: PanelAuditInput): D1PreparedStatement {
  if (!isFactoryAudit(a.action)) throw new Error(`Not a factory audit action: ${a.action}`);
  return db
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
    );
}

export async function writeFactoryAudit(db: D1Database, a: PanelAuditInput): Promise<void> {
  await factoryAuditStatement(db, a).run();
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

/** Core's cursor format (`workers/core/src/admin/index.ts`): the row id in unpadded base64. */
export function encodeAuditCursor(id: number): string {
  return btoa(String(id)).replace(/=+$/, "");
}

export function decodeAuditCursor(cursor: string): number | null {
  try {
    const value = Number(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

interface AuditListOpts {
  actorId?: string;
  targetType?: string;
  targetId?: string;
  limit: number;
  beforeId?: number;
}

/** Panel-only rows, newest first. `actorId` restricts to one actor (employee scope); `beforeId` keeps rows with a lower id (paging). */
export async function listPanelAudit(db: D1Database, opts: AuditListOpts): Promise<AuditEntryT[]> {
  const where = ["(action LIKE 'auth.%' OR action LIKE 'user.%')"];
  const binds: unknown[] = [];
  if (opts.actorId) {
    binds.push(opts.actorId);
    where.push(`actor_id = ?${binds.length}`);
  }
  if (opts.targetType) { binds.push(opts.targetType); where.push(`entity_type = ?${binds.length}`); }
  if (opts.targetId) { binds.push(opts.targetId); where.push(`entity_id = ?${binds.length}`); }
  if (opts.beforeId !== undefined) { binds.push(opts.beforeId); where.push(`id < ?${binds.length}`); }
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
export async function listLifecycleAudit(db: D1Database, opts: AuditListOpts): Promise<AuditEntryT[]> {
  const where = ["action NOT LIKE 'auth.%'", "action NOT LIKE 'user.%'"];
  const binds: unknown[] = [];
  if (opts.actorId) { binds.push(opts.actorId); where.push(`actor_id = ?${binds.length}`); }
  if (opts.targetType) { binds.push(opts.targetType); where.push(`entity_type = ?${binds.length}`); }
  if (opts.targetId) { binds.push(opts.targetId); where.push(`entity_id = ?${binds.length}`); }
  if (opts.beforeId !== undefined) { binds.push(opts.beforeId); where.push(`id < ?${binds.length}`); }
  binds.push(opts.limit);
  const { results } = await db.prepare(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?${binds.length}`).bind(...binds).all<Row>();
  return results.map((r) => AuditEntry.parse({ id: r.id, actor_id: r.actor_id, actor_role: r.actor_role, action: r.action, target: { type: r.entity_type, id: r.entity_id }, old: r.before_json ? JSON.parse(r.before_json) : null, new: r.after_json ? JSON.parse(r.after_json) : null, at: r.created_at }));
}
