-- Migration 0008: the favicon and logo a brand serves.
--
-- The panel writes a row after the bytes pass the brand-clean scan; core reads it for the brand Worker's
-- `brandAsset` RPC. Bytes are base64 text (as in template_upload_chunks), capped at 256 KiB, so a row stays far
-- below D1's 2 MB limit. At most one favicon and one logo per brand. Never lead data, never secrets.

CREATE TABLE IF NOT EXISTS brand_assets (
  brand_id     TEXT NOT NULL REFERENCES brands(brand_id),
  kind         TEXT NOT NULL CHECK (kind IN ('favicon', 'logo')),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/svg+xml', 'image/x-icon')),
  byte_length  INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 262144),
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
  body_base64  TEXT NOT NULL CHECK (length(body_base64) BETWEEN 4 AND 349528),
  updated_by   TEXT NOT NULL,                    -- auth user id
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (brand_id, kind)
);
