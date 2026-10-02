-- T6c: opaque, single-use provider continuations. Only token hashes are persisted.
CREATE TABLE continuations (
  token_hash TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(lead_id),
  brand_id TEXT NOT NULL REFERENCES brand_runtime(brand_id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_continuations_expires ON continuations(expires_at);

-- Ownership is explicit; hostname alone is not an account/brand authorization boundary.
ALTER TABLE click_sessions ADD COLUMN brand_id TEXT;

-- Additional evidence uses the authenticated brand Worker's request context.
ALTER TABLE consent_evidence ADD COLUMN consent_text_hash TEXT;
ALTER TABLE consent_evidence ADD COLUMN consent_brand TEXT;
ALTER TABLE consent_evidence ADD COLUMN gpc INTEGER CHECK (gpc IS NULL OR gpc IN (0, 1));

-- Existing installs use /request until the installer writes their configured route.
ALTER TABLE brand_runtime ADD COLUMN form_route TEXT NOT NULL DEFAULT '/request';
