-- Migration 010 — AURUM V2 Core session persistence (C9-A)
--
-- WHY: src/core/session-store.mjs (C4-A) has held every V2 session in a module-level
-- `Map` since it was written — deliberately, per its own header comment, as
-- "local/synthetic persistence only... per this task's PRODUCTION_MUTATIONS=0 scope".
-- That was correct for a foundation layer with no request-path wiring. C8-A wired it into
-- a real request handler (request-orchestrator.mjs -> functions/api/[[path]].ts), and
-- Cloudflare Workers/Pages Functions isolates are not long-lived processes: a session
-- created on one isolate has no guarantee of surviving to the next request, which may run
-- on a fresh isolate with an empty Map. This migration adds the two tables needed to move
-- that state into D1, which is the only durable storage this runtime offers (there is no
-- synchronous, in-process alternative on Workers).
--
-- SCOPE: schema only. The corresponding rewrite of session-store.mjs's five exported
-- functions (createSession, resumeSession, transitionStep, submitFinal,
-- getAuthoritativeSessionContext) to read/write these tables — and the mechanical
-- async/await conversion of its five direct/indirect Core callers this requires — is
-- tracked and implemented alongside this file in the same C9-A task, per team-lead's
-- explicit scope approval (task #4dbf3144, comment dc28097e): "preserve contract" means
-- preserving the *observable* API contract (data shape + error semantics), not literal
-- synchronousness, since no synchronous storage API exists on this platform.
--
-- Apply once: wrangler d1 execute aurum_v2_local --remote --file=db/migrations/010_v2_sessions.sql
-- (Fresh databases get this from db/schema.sql directly, once schema.sql is updated to
-- include it — this project's existing db/schema.sql is V1/leads-only as of this writing.)
--
-- NOT IDEMPOTENT beyond the CREATE TABLE/INDEX IF NOT EXISTS guards below: there is no
-- ALTER TABLE in this migration, so a second apply is a no-op either way.

-- One row per session. Mirrors session-store.mjs's in-memory record shape field-for-field
-- (sessionRef, brandId, workflowId, workflowVersion, steps, currentStepIndex, status,
-- createdAt, expiresAt) so the D1-backed rewrite is a storage-layer swap only, not a shape
-- change — see PII-POLICY.md §1: this table stores zero applicant PII, only structural
-- session state, exactly as the in-memory Map did.
CREATE TABLE IF NOT EXISTS v2_sessions (
  session_ref         TEXT PRIMARY KEY,      -- opaque ref, e.g. "sess_<uuid>"; never guessable
  brand_id            TEXT NOT NULL,
  workflow_id         TEXT NOT NULL,
  workflow_version    TEXT NOT NULL,
  steps               TEXT NOT NULL,         -- JSON array of step ids, in workflow order
  current_step_index  INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | EXPIRED | SUBMITTED
  created_at          INTEGER NOT NULL,      -- epoch ms, server clock (`now` at createSession)
  expires_at          INTEGER NOT NULL       -- epoch ms; EXPIRED transition is sticky (see
                                              -- session-store.mjs's getLiveRecord doc comment)
);

-- Session lookup by ref is the primary-key path already; this index serves the sweep this
-- module may eventually want for expired-row cleanup (not part of this migration's scope,
-- but the column pairing costs nothing to add now and avoids a second migration later).
CREATE INDEX IF NOT EXISTS idx_v2_sessions_status_expires
  ON v2_sessions (status, expires_at);

-- One row per accepted final submission, keyed by (session_ref, idempotency_key) so a
-- replayed submitFinal call for the same session+key is a single, idempotent row rather
-- than a duplicate lead — mirrors the in-memory record's own
-- `submissions: Map<idempotencyKey, { submissionRef, projection }>` exactly. A UNIQUE
-- constraint on the composite key (via PRIMARY KEY) is load-bearing, not incidental: it is
-- what makes two concurrent submitFinal calls for the same session+key resolve to one
-- winning row instead of two, without requiring a separate application-level lock (see
-- the isolation tests this task adds alongside this migration).
CREATE TABLE IF NOT EXISTS v2_session_submissions (
  session_ref       TEXT NOT NULL REFERENCES v2_sessions (session_ref),
  idempotency_key   TEXT NOT NULL,
  submission_ref    TEXT NOT NULL,     -- opaque ref, e.g. "sub_<uuid>"
  projection        TEXT NOT NULL,     -- JSON of the exact "submit" projection returned to the caller
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (session_ref, idempotency_key)
);

-- submitFinal's dedup-by-key lookup is already the primary key above; this index serves a
-- different lookup this same table structurally supports (status/history-by-submissionRef)
-- without requiring a second table, should a future caller need it.
CREATE INDEX IF NOT EXISTS idx_v2_session_submissions_submission_ref
  ON v2_session_submissions (submission_ref);
