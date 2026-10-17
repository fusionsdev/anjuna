-- Migration 0006: chunked builder uploads (template MCP begin_upload / upload_files / finish_upload).
--
-- For builders that cannot publish a site and cannot pass dist/ in one tool call. An upload belongs to
-- one builder key; finish_upload joins the chunks, submits them and deletes both rows. Uploads older than
-- six hours are pruned. Rows hold template files, never lead data.

CREATE TABLE IF NOT EXISTS template_uploads (
  upload_id     TEXT PRIMARY KEY,
  key_id        TEXT NOT NULL REFERENCES builder_keys(key_id),
  template_id   TEXT NOT NULL,
  template_name TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_template_uploads_created ON template_uploads(created_at);

CREATE TABLE IF NOT EXISTS template_upload_chunks (
  upload_id TEXT NOT NULL REFERENCES template_uploads(upload_id),
  path      TEXT NOT NULL,
  part      INTEGER NOT NULL CHECK (part BETWEEN 0 AND 9999),
  encoding  TEXT NOT NULL CHECK (encoding IN ('utf8', 'base64')),
  content   TEXT NOT NULL,
  PRIMARY KEY (upload_id, path, part)
);
