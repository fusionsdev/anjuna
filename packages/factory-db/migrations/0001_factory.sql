-- Migration 0001 — Anjuna Factory D1 (`factory`): templates, form artifacts, brands, installs, audit.
--
-- Used by the control panel (T12) and the install / rollback / upgrade-all Workflows (T10/T11).
-- No secrets live here: Cloudflare tokens and per-brand secrets are Worker secrets, referenced by
-- name only. Timestamps are ISO-8601 UTC text, matching the leads D1.

-- A landing template (TP-1). Immutable content lives in template_versions.
CREATE TABLE IF NOT EXISTS templates (
  template_id  TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  framework    TEXT NOT NULL CHECK (framework IN ('astro', 'next_export', 'react_spa')),
  created_by   TEXT NOT NULL,                    -- auth user id
  created_at   TEXT NOT NULL,
  archived_at  TEXT
);

-- One uploaded build of a template. Sealed versions are immutable and identified by SHA-256 (TP-3).
CREATE TABLE IF NOT EXISTS template_versions (
  template_version_id TEXT PRIMARY KEY,
  template_id         TEXT NOT NULL REFERENCES templates(template_id),
  version             INTEGER NOT NULL,
  sha256              TEXT NOT NULL UNIQUE,      -- hex SHA-256 of the static dist/ archive
  r2_key              TEXT NOT NULL,             -- where the archive is stored in R2
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'certifying', 'certified', 'rejected', 'sealed')),
  sealed_by           TEXT,                      -- owner user id
  sealed_at           TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (template_id, version),
  CHECK ((status = 'sealed') = (sealed_at IS NOT NULL))
);

-- Certification checks run on a template version (TP-3): lint, identity scan, screenshots.
CREATE TABLE IF NOT EXISTS certifications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  template_version_id TEXT NOT NULL REFERENCES template_versions(template_version_id),
  check_name          TEXT NOT NULL
                        CHECK (check_name IN ('lint', 'identity_scan', 'screenshot_desktop', 'screenshot_mobile')),
  result              TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  details_json        TEXT,                      -- findings; never secrets
  artifact_r2_key     TEXT,                      -- e.g. the screenshot
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_certifications_version ON certifications(template_version_id, check_name);

-- Anjuna Form builds, uploaded by CI to R2 as form@<sha> with a SHA-256 manifest (FO-4).
CREATE TABLE IF NOT EXISTS form_artifacts (
  form_artifact_id TEXT PRIMARY KEY,
  git_sha          TEXT NOT NULL UNIQUE,
  r2_key           TEXT NOT NULL,
  manifest_sha256  TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

-- A brand as the factory sees it. The runtime copy core serves lives in the leads D1
-- (brand_runtime); brand_id is the shared key.
CREATE TABLE IF NOT EXISTS brands (
  brand_id            TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  account             TEXT NOT NULL,             -- installation/account label (no Cloudflare account id)
  domain              TEXT NOT NULL UNIQUE,      -- apex hostname, lowercase
  keyword_default     TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'installing', 'live', 'paused', 'failed', 'retired')),
  current_revision_id TEXT,                      -- brand_revisions.revision_id now deployed; NULL before first install
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brands_account ON brands(account);

-- Every deployable state of a brand: template version + form artifact + runtime config.
CREATE TABLE IF NOT EXISTS brand_revisions (
  revision_id         TEXT PRIMARY KEY,
  brand_id            TEXT NOT NULL REFERENCES brands(brand_id),
  revision            INTEGER NOT NULL,
  template_version_id TEXT NOT NULL REFERENCES template_versions(template_version_id),
  form_artifact_id    TEXT NOT NULL REFERENCES form_artifacts(form_artifact_id),
  config_json         TEXT NOT NULL,             -- runtime config snapshot (buckets, keyword default, A/B, gate mode)
  worker_version_id   TEXT,                      -- Cloudflare Worker version id once deployed
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (brand_id, revision),
  CHECK (json_valid(config_json))
);

-- One Workflow run: install-brand, rollback-brand or one brand of upgrade-all (FA-1, FA-2).
CREATE TABLE IF NOT EXISTS installs (
  install_id           TEXT PRIMARY KEY,
  brand_id             TEXT NOT NULL REFERENCES brands(brand_id),
  kind                 TEXT NOT NULL CHECK (kind IN ('install', 'rollback', 'upgrade')),
  workflow_instance_id TEXT UNIQUE,
  from_revision_id     TEXT REFERENCES brand_revisions(revision_id),  -- NULL on a first install
  to_revision_id       TEXT REFERENCES brand_revisions(revision_id),
  rollback_record_json TEXT,                     -- state saved before changing anything (step 2)
  is_canary            INTEGER NOT NULL DEFAULT 0 CHECK (is_canary IN (0, 1)),
  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'running', 'ready', 'failed', 'rolled_back')),
  error                TEXT,
  started_by           TEXT NOT NULL,
  started_at           TEXT NOT NULL,
  finished_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_installs_brand ON installs(brand_id, started_at);

-- One row per idempotent Workflow step; a re-run finds the receipt and skips the step.
CREATE TABLE IF NOT EXISTS install_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id  TEXT NOT NULL REFERENCES installs(install_id),
  step        TEXT NOT NULL CHECK (step IN (
                'validate', 'save_rollback', 'render', 'upload_assets', 'upload_script',
                'deploy', 'attach_domains', 'smoke', 'receipt', 'rollback')),
  status      TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
  output_json TEXT,                              -- ids created by the step (version id, domain ids, ...)
  created_at  TEXT NOT NULL,
  UNIQUE (install_id, step)
);

-- Every change made through the control panel (FA-3). Append-only.
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id     TEXT NOT NULL,                    -- auth user id, or 'system' for Workflows/cron
  actor_role   TEXT NOT NULL CHECK (actor_role IN ('owner', 'employee', 'system')),
  action       TEXT NOT NULL,                    -- e.g. brand.pause, template.seal, install.start
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- Sealed template versions are immutable (TP-3).
CREATE TRIGGER IF NOT EXISTS template_versions_sealed_immutable BEFORE UPDATE ON template_versions
WHEN OLD.status = 'sealed'
BEGIN
  SELECT RAISE(ABORT, 'sealed template versions are immutable');
END;
