-- Migration 0021: hourly crawler counters (panel redesign T12).
-- 0019 is ad_spend_currency; 0020 is reserved for the AdKit queue task.
-- Brand Workers report Googlebot, AdsBot and other crawler hits through the botHit RPC. Core
-- only counts them: no response varies by crawler (AGENTS.md rule 3). No IP, no user agent
-- string and no path is stored, only one counter per brand, UTC clock hour and kind.
CREATE TABLE IF NOT EXISTS bot_hits (
  brand_id TEXT NOT NULL,
  hour     TEXT NOT NULL CHECK (length(hour) = 20 AND hour LIKE '____-__-__T__:00:00Z'),
  kind     TEXT NOT NULL CHECK (kind IN ('googlebot', 'adsbot', 'other-bot')),
  hits     INTEGER NOT NULL DEFAULT 0 CHECK (typeof(hits) = 'integer' AND hits >= 0),
  PRIMARY KEY (brand_id, hour, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_bot_hits_hour ON bot_hits (hour, kind);
