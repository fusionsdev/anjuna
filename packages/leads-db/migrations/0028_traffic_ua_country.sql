ALTER TABLE traffic_events ADD COLUMN user_agent_family TEXT;
ALTER TABLE traffic_events ADD COLUMN country TEXT;
ALTER TABLE traffic_events ADD COLUMN region TEXT;
-- idx_traffic_events_created_step already covers the created_at prefix.
CREATE INDEX idx_traffic_events_brand_created ON traffic_events(brand, created_at);
