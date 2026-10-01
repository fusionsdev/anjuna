-- Spike subset of the V1 schema (columns trimmed to what the loop needs).
CREATE TABLE IF NOT EXISTS click_sessions (
  click_session_id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  gclid TEXT, gbraid TEXT, wbraid TEXT, msclkid TEXT,
  keyword TEXT,
  utm_json TEXT,
  claimed_lead_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
  lead_id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  requested_amount INTEGER NOT NULL,
  zip TEXT NOT NULL,
  first_name TEXT, last_name TEXT, email TEXT, home_phone TEXT,
  keyword TEXT,
  gclid TEXT, gbraid TEXT, wbraid TEXT, msclkid TEXT,
  click_session_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS continuations (
  token TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS postback_events (
  lead_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payout REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (lead_id, event_type)
);
CREATE TABLE IF NOT EXISTS conversion_uploads (
  lead_id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  hostname TEXT NOT NULL,
  gclid TEXT, gbraid TEXT, wbraid TEXT, msclkid TEXT,
  value REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL
);
