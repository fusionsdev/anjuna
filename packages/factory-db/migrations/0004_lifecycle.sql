-- Migration 0004 — lifecycle state and verified form payload metadata.
-- All additions are local persistence only; no remote migrations or external calls are implied.

ALTER TABLE form_artifacts ADD COLUMN payload_version TEXT;
ALTER TABLE form_artifacts ADD COLUMN bundle_form_version TEXT
  CHECK (bundle_form_version IS NULL OR bundle_form_version GLOB 'form@*');

CREATE TRIGGER IF NOT EXISTS form_artifacts_payload_version_immutable
BEFORE UPDATE OF payload_version ON form_artifacts
WHEN OLD.payload_version IS NOT NULL
 AND (NEW.payload_version IS NULL OR NEW.payload_version <> OLD.payload_version)
BEGIN
  SELECT RAISE(ABORT, 'form_artifacts payload_version is immutable');
END;

CREATE TRIGGER IF NOT EXISTS form_artifacts_bundle_form_version_immutable
BEFORE UPDATE OF bundle_form_version ON form_artifacts
WHEN OLD.bundle_form_version IS NOT NULL
 AND (NEW.bundle_form_version IS NULL OR NEW.bundle_form_version <> OLD.bundle_form_version)
BEGIN
  SELECT RAISE(ABORT, 'form_artifacts bundle_form_version is immutable');
END;

ALTER TABLE installs ADD COLUMN started_role TEXT NOT NULL DEFAULT 'employee'
  CHECK (started_role IN ('owner', 'employee', 'system'));

PRAGMA defer_foreign_keys = ON;
ALTER TABLE install_receipts RENAME TO install_receipts_legacy;

CREATE TABLE install_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id  TEXT NOT NULL REFERENCES installs(install_id),
  step        TEXT NOT NULL CHECK (step IN (
                'validate', 'save_rollback', 'render', 'upload_assets', 'upload_script',
                'deploy', 'attach_domains', 'smoke', 'receipt', 'rollback',
                'provision_runtime', 'sync_runtime')),
  status      TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
  output_json TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (install_id, step)
);

INSERT INTO install_receipts (id, install_id, step, status, output_json, created_at)
SELECT id, install_id, step, status, output_json, created_at
FROM install_receipts_legacy;

DROP TABLE install_receipts_legacy;
CREATE INDEX IF NOT EXISTS idx_install_receipts_install ON install_receipts(install_id, created_at);

CREATE TABLE IF NOT EXISTS brand_checklist (
  brand_id       TEXT NOT NULL REFERENCES brands(brand_id),
  item           TEXT NOT NULL CHECK (item IN ('drain_route', 'leadsgate_postbacks', 'test_sold', 'final_url')),
  evidence_json  TEXT NOT NULL CHECK (json_valid(evidence_json)),
  confirmed_by   TEXT NOT NULL,
  confirmed_role TEXT NOT NULL CHECK (confirmed_role IN ('owner', 'employee')),
  confirmed_at   TEXT NOT NULL,
  PRIMARY KEY (brand_id, item)
);

CREATE INDEX IF NOT EXISTS idx_brand_checklist_brand ON brand_checklist(brand_id);
