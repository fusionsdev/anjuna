/**
 * AdKit Terminal (T13-6, spec Part C). The panel sends one `adkit manage ...` line; core parses it against the same
 * allowlist module the VPS executor uses (scripts/drain/adkit-allowlist.mjs, a pure module with no Node imports) and,
 * only when it is allowed, queues a `terminal.run` job on the T9 adkit_jobs queue. Core never calls AdKit.
 *
 * Admin routes (owner only, dispatched from admin/index.ts; core re-checks the role itself):
 *   POST /admin/adkit/terminal   parse the line; `dry_run` answers the argv, otherwise a job row is inserted
 *   GET  /admin/adkit/jobs/:id   one terminal job with its masked output (at most 20 KB)
 *
 * Rules:
 *   - A refused line (not on the allowlist, a shell character, the wrong mode) is 422 before any row exists.
 *   - Read mode never queues a write; draft mode may create a draft; publish mode needs `confirm: true`. Enabling a
 *     campaign is refused here: the campaigns page checks the baht caps, the Terminal does not.
 *   - Output and error text are masked (click ids, tokens) and cut at 20 KB when the result arrives and again when it
 *     is read. A terminal job is never retried and a claim that expires fails it, because a write could run twice.
 */
import {
  AdkitJobStatus,
  TerminalJobResponse,
  TerminalJobView,
  TerminalRunPayload,
  TerminalRunRequest,
  TerminalRunResponse,
  roleAtLeast,
  type AdminRequestContext,
  type TerminalMode,
  type TerminalRunResult,
} from "@anjuna/contracts";
import {
  parseTerminalLine as parseLine,
  redactTerminalOutput as redact,
} from "../../../scripts/drain/adkit-allowlist.mjs";
import { JOB_BODY_LIMIT, NEXT_EVENT, NEXT_SEQ, adminError, audit, parseBody, writeDoneAudit, type JobRow } from "./adkit.js";
import type { Env } from "./env.js";
import { json } from "./http.js";

export type TerminalParse = { ok: true; argv: string[]; mode: TerminalMode } | { ok: false; reason: string };

/** The line as an argv for the mode, or why it is refused. Pure; nothing runs and no row is written. */
export function parseTerminalLine(line: string, mode: TerminalMode): TerminalParse {
  return parseLine(line, mode);
}

/** Click ids and tokens hidden, at most 20 KB. */
export const redactTerminalOutput: (text: unknown) => string = redact;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_TERMINAL_MAX = 20;

/** The view of a terminal row. A row whose payload no longer parses is read as null by the caller. */
function terminalView(row: JobRow): TerminalJobView | null {
  const payload = TerminalRunPayload.safeParse(JSON.parse(row.payload));
  if (!payload.success) return null;
  let output: string | null = null;
  let error: string | null = null;
  if (row.result !== null) {
    const result = JSON.parse(row.result) as Record<string, unknown>;
    if (typeof result.output === "string") output = redact(result.output);
    if (typeof result.error === "string") error = redact(result.error);
  }
  return TerminalJobView.parse({
    id: row.id, status: AdkitJobStatus.parse(row.status), mode: payload.data.mode, line: payload.data.line,
    output, error, requested_by: row.requested_by, created_at: row.created_at, updated_at: row.updated_at,
  });
}

/** POST /admin/adkit/terminal. */
export async function createTerminalJob(request: Request, env: Env, context: AdminRequestContext): Promise<Response> {
  if (!roleAtLeast(context.actor_role, "owner")) return adminError(context, { error: "forbidden_role", required_role: "owner" });
  const body = await parseBody(request, TerminalRunRequest, JOB_BODY_LIMIT * 2);
  if (!body.ok) return adminError(context, { error: "invalid", issues: body.issues ?? [{ path: "body", message: body.message }] });
  const { line, mode } = body.data;

  const parsed = parseTerminalLine(line, mode);
  if (!parsed.ok) return adminError(context, { error: "invalid", issues: [{ path: "line", message: parsed.reason }] });
  if (body.data.dry_run) return json(TerminalRunResponse.parse({ preview: true, argv: parsed.argv, mode, job: null }));
  if (mode === "publish" && body.data.confirm !== true) {
    return adminError(context, { error: "invalid", issues: [{ path: "confirm", message: "ยืนยันก่อนเผยแพร่" }] });
  }

  const open = await env.LEADS.prepare(
    "SELECT COUNT(*) AS n FROM adkit_jobs WHERE kind = 'terminal.run' AND status IN ('queued', 'claimed')",
  ).first<{ n: number }>();
  if ((open?.n ?? 0) >= PENDING_TERMINAL_MAX) {
    return adminError(context, { error: "invalid", issues: [{ path: "line", message: "มีคำสั่งรอรันเกินกำหนด รอให้คิวว่างก่อน" }] });
  }

  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  // The stored line is what the panel shows back, so secret-like values in it are masked; argv stays exact for the executor.
  const payload = TerminalRunPayload.parse({ line: redact(line), argv: parsed.argv, mode });
  await env.LEADS.prepare(`
    INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, created_at, updated_at, seq)
    VALUES (?1, 'terminal.run', ?2, 'queued', NULL, 0, ?3, ?4, ?5, ?5, ${NEXT_SEQ})`)
    .bind(id, JSON.stringify(payload), `terminal:${id}`, context.actor_id, at).run();
  await audit(env, { id: context.actor_id, role: context.actor_role }, "adkit.terminal.run", id, { mode, argv: parsed.argv.map((arg) => redact(arg)) }, at);
  const row = await env.LEADS.prepare("SELECT * FROM adkit_jobs WHERE id = ?1").bind(id).first<JobRow>();
  const job = row ? terminalView(row) : null;
  if (!job) throw new Error("terminal job row missing after insert");
  return json(TerminalRunResponse.parse({ preview: false, argv: parsed.argv, mode, job }), 201);
}

/** GET /admin/adkit/jobs/:id. Only terminal jobs are readable here; any other id or kind is 404. */
export async function getTerminalJob(env: Env, context: AdminRequestContext, id: string): Promise<Response> {
  if (!roleAtLeast(context.actor_role, "owner")) return adminError(context, { error: "forbidden_role", required_role: "owner" });
  const row = UUID.test(id)
    ? await env.LEADS.prepare("SELECT * FROM adkit_jobs WHERE id = ?1 AND kind = 'terminal.run'").bind(id).first<JobRow>()
    : null;
  const job = row ? terminalView(row) : null;
  if (!job) return adminError(context, { error: "not_found", resource: "adkit_job" });
  return json(TerminalJobResponse.parse({ job }));
}

/**
 * The done result of a claimed terminal job. The output is masked and cut here, so what is stored is what the panel
 * may read. A repeat of the stored result is a no-op 200; anything else for a finished job is stale.
 */
export async function handleTerminalResult(
  env: Env, jobId: string, claimId: string, outcome: TerminalRunResult, at: string,
): Promise<Response> {
  const stored = { output: redact(outcome.output) };
  const resultJson = JSON.stringify(stored);
  const write = await env.LEADS.prepare(`
    UPDATE adkit_jobs SET status = 'done', result = ?3, next_attempt_at = NULL, updated_at = ?4, result_seq = ${NEXT_EVENT}
    WHERE id = ?1 AND claim_id = ?2 AND status = 'claimed' AND kind = 'terminal.run'
    RETURNING id`).bind(jobId, claimId, resultJson, at).first<{ id: string }>();
  const audited = { output_bytes: new TextEncoder().encode(stored.output).length };
  if (write) {
    await writeDoneAudit(env, jobId, audited, at);
    return json({ status: "done" });
  }
  const row = await env.LEADS.prepare("SELECT * FROM adkit_jobs WHERE id = ?1").bind(jobId).first<JobRow>();
  if (!row) return json({ status: "invalid", message: "Unknown job_id" }, 404);
  if (row.kind === "terminal.run" && row.status === "done" && row.result === resultJson) {
    if (row.claim_id === claimId) await writeDoneAudit(env, jobId, audited, row.updated_at, true);
    return json({ status: "done", already: true });
  }
  return json({ status: "stale" }, 409);
}
